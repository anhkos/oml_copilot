import { z } from 'zod';
import {
    AnnotationParam,
    insertBeforeClosingBrace,
    loadVocabularyDocument,
    writeFileAndNotify,
    findTerm,
    formatAnnotations,
    collectImportPrefixes,
    appendValidationIfSafeMode,
} from '../common.js';
import { annotationParamSchema } from '../schemas.js';
import { buildKeyLines } from './text-builders.js';
import { preferencesState } from '../preferences/preferences-state.js';
import { ensureImportsHandler } from '../methodology/ensure-imports.js';

const paramsSchema = {
    ontology: z.string().describe('ABSOLUTE path to an EXISTING vocabulary file. If the file does not exist yet, call create_ontology(kind="vocabulary") first.'),
    name: z.string().describe('Aspect name to create'),
    keys: z.array(z.array(z.string())).optional().describe('Optional key property groups'),
    annotations: z.array(annotationParamSchema).optional(),
};

export const createAspectTool = {
    name: 'create_aspect' as const,
    description: 'Creates an aspect in the target vocabulary, with optional key axioms.',
    paramsSchema,
};

export const createAspectMetadata = {
    id: 'create_aspect',
    displayName: 'Create Aspect',
    layer: 'vocabulary' as const,
    severity: 'high' as const,
    version: '1.0.0',
    shortDescription: 'Create an aspect (mixin type) in a vocabulary file',
    description: 'Creates a new aspect (reusable mixin type) in a vocabulary file with optional key axioms.',
    tags: ['type-definition', 'aspect', 'vocabulary', 'mixin'],
    dependencies: [],
    addedDate: '2024-01-01',
};

export const createAspectHandler = async (
    { ontology, name, keys, annotations }: { ontology: string; name: string; keys?: string[][]; annotations?: AnnotationParam[] }
) => {
    try {
        const { vocabulary, filePath, fileUri, text, eol, indent } = await loadVocabularyDocument(ontology);

        // Collect all referenced prefixes
        const allReferencedNames = [
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
                    { type: 'text' as const, text: `Aspect "${name}" already exists in the vocabulary.` },
                ],
            };
        }

        const innerIndent = indent + indent;
        const annotationsText = formatAnnotations(annotations, indent, eol);
        const keyText = buildKeyLines(keys, innerIndent, eol);
        const block = keyText ? ` [${eol}${keyText}${indent}]` : '';

        const aspectText = `${annotationsText}${indent}aspect ${name}${block}${eol}${eol}`;
        const newContent = insertBeforeClosingBrace(currentText, aspectText);
        await writeFileAndNotify(currentFilePath, currentFileUri, newContent);

        const notes: string[] = [];
        if (missing.length > 0) {
            notes.push(`Auto-added imports for: ${missing.join(', ')}.`);
        }

        const result = {
            content: [
                { type: 'text' as const, text: `✓ Created aspect "${name}"${notes.length ? '\n' + notes.join(' ') : ''}\n\nGenerated code:\n${aspectText.trim()}` },
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
                    text: `Error creating aspect: ${error instanceof Error ? error.message : String(error)}`,
                },
            ],
        };
    }
};
