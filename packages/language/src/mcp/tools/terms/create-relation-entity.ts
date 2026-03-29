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
import { buildFromToLines, buildForwardReverse, buildRelationFlags, buildKeyLines } from './text-builders.js';
import { preferencesState } from '../preferences/preferences-state.js';
import { resolveSymbolName, createResolutionErrorResult, type OmlSymbolType } from '../query/index.js';
import { ensureImportsHandler } from '../methodology/ensure-imports.js';

const paramsSchema = {
    ontology: z.string().describe('ABSOLUTE path to an EXISTING vocabulary file. If the file does not exist yet, call create_ontology(kind="vocabulary") first.'),
    name: z.string().describe('Relation entity name to create'),
    sources: z.array(z.string()).optional().describe('Source entities. Simple or qualified names are auto-resolved; imports are added automatically. Use suggest_oml_symbols only if you need to discover names when resolution fails.'),
    targets: z.array(z.string()).optional().describe('Target entities. Simple or qualified names are auto-resolved; imports are added automatically. Use suggest_oml_symbols only if you need to discover names when resolution fails.'),
    forwardName: z.string().optional().describe('Forward role name'),
    reverseName: z.string().optional().describe('Reverse role name'),
    functional: z.boolean().optional(),
    inverseFunctional: z.boolean().optional(),
    symmetric: z.boolean().optional(),
    asymmetric: z.boolean().optional(),
    reflexive: z.boolean().optional(),
    irreflexive: z.boolean().optional(),
    transitive: z.boolean().optional(),
    keys: z.array(z.array(z.string())).optional(),
    superTerms: z.array(z.string()).optional().describe('Optional parent terms this relation entity specializes. Simple or qualified names are auto-resolved; imports are added automatically. Use suggest_oml_symbols only if you need to discover names when resolution fails.'),
    annotations: z.array(annotationParamSchema).optional(),
};

export const createRelationEntityTool = {
    name: 'create_relation_entity' as const,
    description: `[ADVANCED - DO NOT USE BY DEFAULT] Creates a relation entity, which is a special reified relation that can be instantiated and have properties attached. ONLY use this tool when the user explicitly requests a "relation entity" or when you need to create instances of the relation itself or attach scalar properties to it. For normal relationships between entities, use create_relation instead.

Auto-resolves simple or qualified sources/targets/superTerms and adds missing imports. If a name is ambiguous, you'll be prompted to disambiguate; use suggest_oml_symbols only as a last resort to discover names.`,
    paramsSchema,
};

export const createRelationEntityMetadata = {
    id: 'create_relation_entity',
    displayName: 'Create Relation Entity',
    layer: 'vocabulary' as const,
    severity: 'high' as const,
    version: '1.0.0',
    shortDescription: 'Create a reified relation entity (advanced)',
    description: 'Creates a reified relation entity in a vocabulary file. Only use when you need to instantiate relations or attach properties to them. For normal relationships, use create_relation instead.',
    tags: ['relation-definition', 'relation-entity', 'vocabulary', 'reified-relation', 'advanced'],
    dependencies: [],
    addedDate: '2024-01-01',
};

export const createRelationEntityHandler = async (
    params: {
        ontology: string;
        name: string;
        sources?: string[];
        targets?: string[];
        forwardName?: string;
        reverseName?: string;
        functional?: boolean;
        inverseFunctional?: boolean;
        symmetric?: boolean;
        asymmetric?: boolean;
        reflexive?: boolean;
        irreflexive?: boolean;
        transitive?: boolean;
        keys?: string[][];
        superTerms?: string[];
        annotations?: AnnotationParam[];
    }
) => {
    const {
        ontology,
        name,
        sources,
        targets,
        forwardName,
        reverseName,
        functional,
        inverseFunctional,
        symmetric,
        asymmetric,
        reflexive,
        irreflexive,
        transitive,
        keys,
        annotations,
    } = params;

    try {
        const { vocabulary, filePath, fileUri, text, eol, indent } = await loadVocabularyDocument(ontology);

        // Resolve sources, targets, and superTerms - support both simple names and qualified names
        const entityTypes: OmlSymbolType[] = ['concept', 'aspect', 'relation_entity'];
        const resolvedSources: string[] = [];
        const resolvedTargets: string[] = [];
        const resolvedSuperTerms: string[] = [];
        
        if (sources && sources.length > 0) {
            for (const src of sources) {
                const resolution = await resolveSymbolName(src, fileUri, entityTypes);
                if (!resolution.success) {
                    return createResolutionErrorResult(resolution, src, 'source entity');
                }
                resolvedSources.push(stripLocalPrefix(resolution.qualifiedName!, vocabulary.prefix));
            }
        }
        
        if (targets && targets.length > 0) {
            for (const tgt of targets) {
                const resolution = await resolveSymbolName(tgt, fileUri, entityTypes);
                if (!resolution.success) {
                    return createResolutionErrorResult(resolution, tgt, 'target entity');
                }
                resolvedTargets.push(stripLocalPrefix(resolution.qualifiedName!, vocabulary.prefix));
            }
        }
        
        if (params.superTerms && params.superTerms.length > 0) {
            for (const st of params.superTerms) {
                const resolution = await resolveSymbolName(st, fileUri, entityTypes);
                if (!resolution.success) {
                    return createResolutionErrorResult(resolution, st, 'super term');
                }
                resolvedSuperTerms.push(stripLocalPrefix(resolution.qualifiedName!, vocabulary.prefix));
            }
        }

        // Collect all referenced prefixes
        const allReferencedNames = [
            ...resolvedSources,
            ...resolvedTargets,
            ...resolvedSuperTerms,
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
                    { type: 'text' as const, text: `Relation entity "${name}" already exists in the vocabulary.` },
                ],
            };
        }

        const innerIndent = indent + indent;
        const annotationsText = formatAnnotations(annotations, indent, eol);

        let body = '';
        body += buildFromToLines(resolvedSources.length > 0 ? resolvedSources : undefined, resolvedTargets.length > 0 ? resolvedTargets : undefined, innerIndent, eol);
        body += buildForwardReverse(forwardName, reverseName, innerIndent, eol);
        body += buildRelationFlags(
            { functional, inverseFunctional, symmetric, asymmetric, reflexive, irreflexive, transitive },
            innerIndent,
            eol
        );
        body += buildKeyLines(keys, innerIndent, eol);

        const block = body ? ` [${eol}${body}${indent}]` : '';
        const specializationText = resolvedSuperTerms.length > 0 ? ` < ${Array.from(new Set(resolvedSuperTerms)).join(', ')}` : '';
        // For relation entity, specialization appears after the block per style
        const relationText = `${annotationsText}${indent}relation entity ${name}${block}${specializationText}${eol}${eol}`;

        const newContent = insertBeforeClosingBrace(currentText, relationText);
        await writeFileAndNotify(currentFilePath, currentFileUri, newContent);

        const notes: string[] = [];
        if (missing.length > 0) {
            notes.push(`Auto-added imports for: ${missing.join(', ')}.`);
        }

        const result = {
            content: [
                { type: 'text' as const, text: `✓ Created relation entity "${name}"${notes.length ? '\n' + notes.join(' ') : ''}\n\nGenerated code:\n${relationText.trim()}` },
            ],
        };

        // Run validation if safe mode is enabled
        const safeMode = preferencesState.getPreferences().safeMode ?? false;
        return appendValidationIfSafeMode(result, currentFileUri, safeMode);
    } catch (error) {
        return {
            isError: true,
            content: [
                { type: 'text' as const, text: `Error creating relation entity: ${error instanceof Error ? error.message : String(error)}` },
            ],
        };
    }
};
