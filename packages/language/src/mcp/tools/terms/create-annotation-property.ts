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
import { preferencesState } from '../preferences/preferences-state.js';
import { ensureImportsHandler } from '../methodology/ensure-imports.js';

const paramsSchema = {
    ontology: z.string().describe('ABSOLUTE path to an EXISTING vocabulary file. If the file does not exist yet, call create_ontology(kind="vocabulary") first.'),
    name: z.string().describe('Annotation property name to create'),
    annotations: z.array(annotationParamSchema).optional(),
};

export const createAnnotationPropertyTool = {
    name: 'create_annotation_property' as const,
    description: 'Creates an annotation property.',
    paramsSchema,
};

export const createAnnotationPropertyMetadata = {
    id: 'create_annotation_property',
    displayName: 'Create Annotation Property',
    layer: 'vocabulary' as const,
    severity: 'medium' as const,
    version: '1.0.0',
    shortDescription: 'Create an annotation property in a vocabulary file',
    description: 'Creates a new annotation property in a vocabulary file for metadata purposes.',
    tags: ['property-definition', 'annotation', 'vocabulary', 'metadata'],
    dependencies: [],
    addedDate: '2024-01-01',
};

export const createAnnotationPropertyHandler = async (
    { ontology, name, annotations }: { ontology: string; name: string; annotations?: AnnotationParam[] }
) => {
    try {
        const { vocabulary, filePath, fileUri, text, eol, indent } = await loadVocabularyDocument(ontology);

        // Disallow creating properties in another namespace or with prefixed names.
        // This prevents accidentally re-defining imported properties like base:expression.
        if (name.includes(':')) {
            const vocabPrefix = (vocabulary as any).prefix as string | undefined;
            const [givenPrefix] = name.split(':', 2);
            if (!vocabPrefix || givenPrefix !== vocabPrefix) {
                return {
                    isError: true,
                    content: [{
                        type: 'text' as const,
                        text: `Refusing to create annotation property "${name}" because it is prefixed. ` +
                              `Create properties only in this vocabulary's namespace (use an unprefixed name), ` +
                              `or reuse the existing imported property instead.`
                    }],
                };
            }
            return {
                isError: true,
                content: [{
                    type: 'text' as const,
                    text: `Use an unprefixed name when defining properties in this vocabulary. ` +
                          `Provided: "${name}". Local prefix is "${vocabPrefix}".`
                }],
            };
        }

        // Collect all referenced prefixes
        const allReferencedNames = annotations?.map(a => a.property) ?? [];
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
                    { type: 'text' as const, text: `Annotation property "${name}" already exists in the vocabulary.` },
                ],
            };
        }

        const annotationsText = formatAnnotations(annotations, indent, eol);
        const propertyText = `${annotationsText}${indent}annotation property ${name}${eol}${eol}`;

        const newContent = insertBeforeClosingBrace(currentText, propertyText);
        await writeFileAndNotify(currentFilePath, currentFileUri, newContent);

        const notes: string[] = [];
        if (missing.length > 0) {
            notes.push(`Auto-added imports for: ${missing.join(', ')}.`);
        }

        const result = {
            content: [
                { type: 'text' as const, text: `✓ Created annotation property "${name}"${notes.length ? '\n' + notes.join(' ') : ''}\n\nGenerated code:\n${propertyText.trim()}` },
            ],
        };

        // Run validation if safe mode is enabled
        const safeMode = preferencesState.getPreferences().safeMode ?? false;
        return appendValidationIfSafeMode(result, currentFileUri, safeMode);
    } catch (error) {
        return {
            isError: true,
            content: [
                { type: 'text' as const, text: `Error creating annotation property: ${error instanceof Error ? error.message : String(error)}` },
            ],
        };
    }
};
