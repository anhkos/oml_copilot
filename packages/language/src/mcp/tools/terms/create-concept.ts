import { z } from 'zod';
import {
    AnnotationParam,
    insertBeforeClosingBrace,
    loadVocabularyDocument,
    writeFileAndNotify,
    findTerm,
    formatAnnotations,
    stripLocalPrefix,
    collectImportPrefixes,
    appendValidationIfSafeMode,
} from '../common.js';
import { annotationParamSchema } from '../schemas.js';
import { buildInstanceEnumeration, buildKeyLines } from './text-builders.js';
import { preferencesState } from '../preferences/preferences-state.js';
import { resolveSymbolName, createResolutionErrorResult, type OmlSymbolType } from '../query/index.js';
import { ensureImportsHandler } from '../methodology/ensure-imports.js';

const paramsSchema = {
    ontology: z.string().describe('ABSOLUTE path to an EXISTING vocabulary file. If the file does not exist yet, call create_ontology(kind="vocabulary") first.'),
    name: z.string().describe('Concept name to create (must start with capital letter, e.g., "Stakeholder", "Requirement")'),
    keys: z.array(z.array(z.string())).optional().describe('Optional key property groups'),
    instanceEnumeration: z.array(z.string()).optional().describe('Optional instance enumeration list'),
    superTerms: z.array(z.string()).optional().describe('Optional parent concepts/aspects this concept specializes. Simple or qualified names are auto-resolved; imports are added automatically. Use suggest_oml_symbols only if you need to discover names when resolution fails.'),
    annotations: z.array(annotationParamSchema).optional(),
};

export const createConceptTool = {
    name: 'create_concept' as const,
    description: `Creates a concept (type definition) in a VOCABULARY file.

IMPORTANT: This tool is for VOCABULARY files only. Use this for defining reusable TYPES, not specific individuals.

For DESCRIPTION MODELING (creating specific instances like "MissionCommander"):
- Do NOT use this tool
- Instead use create_concept_instance in a description file
- Reference existing concepts from vocabularies (e.g., requirement:Stakeholder)

Auto-resolves simple or qualified superTerms and adds missing imports. If a name is ambiguous, you'll be prompted to disambiguate; use suggest_oml_symbols only as a last resort to discover names.

Example: "concept Stakeholder" defines a TYPE that can have instances.`,
    paramsSchema,
};

export const createConceptMetadata = {
    id: 'create_concept',
    displayName: 'Create Concept',
    layer: 'vocabulary' as const,
    severity: 'critical' as const,
    version: '1.0.0',
    shortDescription: 'Create a concept (type definition) in a vocabulary file',
    description: 'Creates a new concept in a vocabulary file for defining reusable types.',
    tags: ['type-definition', 'concept', 'vocabulary', 'ai-friendly'],
    dependencies: [],
    addedDate: '2024-01-01',
};

export const createConceptHandler = async (
    { ontology, name, keys, instanceEnumeration, superTerms, annotations }: { ontology: string; name: string; keys?: string[][]; instanceEnumeration?: string[]; superTerms?: string[]; annotations?: AnnotationParam[] }
) => {
    try {
        // Ensure concept name starts with capital letter
        if (!/^[A-Z]/.test(name)) {
            return {
                isError: true,
                content: [
                    {
                        type: 'text' as const,
                        text: `Concept name "${name}" must start with a capital letter. OML convention requires concept names to begin with an uppercase character.`,
                    },
                ],
            };
        }

        const { vocabulary, filePath, fileUri, text, eol, indent } = await loadVocabularyDocument(ontology);
        
        // Resolve superTerms - support both simple names and qualified names
        const resolvedSuperTerms: string[] = [];
        if (superTerms && superTerms.length > 0) {
            const entityTypes: OmlSymbolType[] = ['concept', 'aspect', 'relation_entity'];
            for (const st of superTerms) {
                const resolution = await resolveSymbolName(st, fileUri, entityTypes);
                if (!resolution.success) {
                    return createResolutionErrorResult(resolution, st);
                }
                resolvedSuperTerms.push(resolution.qualifiedName!);
            }
        }
        
        // Strip local prefix from resolved superTerms to prevent self-referential qualified names
        const normalizedSuperTerms = resolvedSuperTerms.map(st => stripLocalPrefix(st, vocabulary.prefix));

        // Collect all referenced prefixes
        const allReferencedNames = [
            ...(normalizedSuperTerms ?? []),
            ...(keys?.flat() ?? []),
            ...(annotations?.map(a => a.property) ?? []),
        ];
        const referencedPrefixes = new Set<string>();
        for (const ref of allReferencedNames) {
            if (ref.includes(':')) {
                referencedPrefixes.add(ref.split(':')[0]);
            }
        }

        // Check which prefixes are missing
        let existingPrefixes = collectImportPrefixes(text, vocabulary.prefix);
        const missing = [...referencedPrefixes].filter(p => !existingPrefixes.has(p));
        
        // Auto-add missing imports
        let currentText = text;
        let currentFilePath = filePath;
        let currentFileUri = fileUri;
        
        if (missing.length > 0) {
            const ensureResult = await ensureImportsHandler({ ontology });
            if (ensureResult.isError) {
                return ensureResult;
            }
            // Reload the document to get updated content with new imports
            const reloaded = await loadVocabularyDocument(ontology);
            currentText = reloaded.text;
            currentFilePath = reloaded.filePath;
            currentFileUri = reloaded.fileUri;
        }

        if (findTerm(vocabulary, name)) {
            return {
                isError: true,
                content: [
                    {
                        type: 'text' as const,
                        text: `Concept "${name}" already exists in the vocabulary.`,
                    },
                ],
            };
        }

        const innerIndent = indent + indent;
        const annotationsText = formatAnnotations(annotations, indent, eol);

        const enumerationText = buildInstanceEnumeration(instanceEnumeration, innerIndent, eol);
        const keyText = buildKeyLines(keys, innerIndent, eol);
        const hasBlock = Boolean(enumerationText || keyText);

        const specializationText = normalizedSuperTerms && normalizedSuperTerms.length > 0 ? ` < ${Array.from(new Set(normalizedSuperTerms)).join(', ')}` : '';
        const block = hasBlock ? ` [${eol}${enumerationText}${keyText}${indent}]` : '';
        const conceptText = `${annotationsText}${indent}concept ${name}${specializationText}${block}${eol}${eol}`;

        const newContent = insertBeforeClosingBrace(currentText, conceptText);
        await writeFileAndNotify(currentFilePath, currentFileUri, newContent);

        const notes: string[] = [];
        if (missing.length > 0) {
            notes.push(`Auto-added imports for: ${missing.join(', ')}.`);
        }

        const result = {
            content: [
                {
                    type: 'text' as const,
                    text: `✓ Created concept "${name}"${notes.length ? '\n' + notes.join(' ') : ''}\n\nGenerated code:\n${conceptText.trim()}`,
                },
            ],
        };

        // Run validation if safe mode is enabled
        const safeMode = preferencesState.getPreferences().safeMode ?? false;
        return appendValidationIfSafeMode(result, currentFileUri, safeMode);
    } catch (error) {
        return {
            isError: true,
            content: [
                {
                    type: 'text' as const,
                    text: `Error creating concept: ${error instanceof Error ? error.message : String(error)}`,
                },
            ],
        };
    }
};
