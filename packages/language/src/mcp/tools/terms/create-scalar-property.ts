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
import { buildDomains, buildRanges } from './text-builders.js';
import { preferencesState } from '../preferences/preferences-state.js';
import { resolveSymbolName, createResolutionErrorResult, type OmlSymbolType } from '../query/index.js';
import { ensureImportsHandler } from '../methodology/ensure-imports.js';

const paramsSchema = {
    ontology: z.string().describe('ABSOLUTE path to an EXISTING vocabulary file. If the file does not exist yet, call create_ontology(kind="vocabulary") first.'),
    name: z.string().describe('Scalar property name to create'),
    domains: z.array(z.string()).optional().describe('Domain entities. Simple or qualified names are auto-resolved; imports are added automatically. Use suggest_oml_symbols only if you need to discover names when resolution fails.'),
    ranges: z.array(z.string()).optional().describe('Range scalars (e.g., xsd:string, xsd:integer). Simple or qualified names are auto-resolved; imports are added automatically. Use suggest_oml_symbols only if you need to discover names when resolution fails.'),
    functional: z.boolean().optional(),
    annotations: z.array(annotationParamSchema).optional(),
};

export const createScalarPropertyTool = {
    name: 'create_scalar_property' as const,
    description: `Creates a scalar property with optional domains, ranges, and functional modifier.

Auto-resolves simple or qualified domains/ranges and adds missing imports. If a name is ambiguous, you'll be prompted to disambiguate; use suggest_oml_symbols only as a last resort to discover names.`,
    paramsSchema,
};

export const createScalarPropertyMetadata = {
    id: 'create_scalar_property',
    displayName: 'Create Scalar Property',
    layer: 'vocabulary' as const,
    severity: 'high' as const,
    version: '1.0.0',
    shortDescription: 'Create a scalar property with optional domains and ranges',
    description: 'Creates a new scalar property in a vocabulary file with optional domain/range constraints and functional modifiers.',
    tags: ['property-definition', 'scalar-property', 'vocabulary', 'relation'],
    dependencies: [],
    addedDate: '2024-01-01',
};

export const createScalarPropertyHandler = async (
    { ontology, name, domains, ranges, functional, annotations }: { ontology: string; name: string; domains?: string[]; ranges?: string[]; functional?: boolean; annotations?: AnnotationParam[] }
) => {
    try {
        const { vocabulary, filePath, fileUri, text, eol, indent } = await loadVocabularyDocument(ontology);

        // Resolve domains (entities) and ranges (scalars)
        const entityTypes: OmlSymbolType[] = ['concept', 'aspect', 'relation_entity'];
        const scalarTypes: OmlSymbolType[] = ['scalar'];
        const resolvedDomains: string[] = [];
        const resolvedRanges: string[] = [];
        
        if (domains && domains.length > 0) {
            for (const dom of domains) {
                const resolution = await resolveSymbolName(dom, fileUri, entityTypes);
                if (!resolution.success) {
                    return createResolutionErrorResult(resolution, dom, 'domain entity');
                }
                resolvedDomains.push(stripLocalPrefix(resolution.qualifiedName!, vocabulary.prefix));
            }
        }
        
        if (ranges && ranges.length > 0) {
            for (const rng of ranges) {
                const resolution = await resolveSymbolName(rng, fileUri, scalarTypes);
                if (!resolution.success) {
                    return createResolutionErrorResult(resolution, rng, 'range scalar');
                }
                resolvedRanges.push(stripLocalPrefix(resolution.qualifiedName!, vocabulary.prefix));
            }
        }

        // Collect all referenced prefixes
        const allReferencedNames = [
            ...resolvedDomains,
            ...resolvedRanges,
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
                    { type: 'text' as const, text: `Scalar property "${name}" already exists in the vocabulary.` },
                ],
            };
        }

        const innerIndent = indent + indent;
        const annotationsText = formatAnnotations(annotations, indent, eol);

        let body = '';
        body += buildDomains(resolvedDomains.length > 0 ? resolvedDomains : undefined, innerIndent, eol);
        body += buildRanges(resolvedRanges.length > 0 ? resolvedRanges : undefined, innerIndent, eol);
        if (functional) {
            body += `${innerIndent}functional${eol}`;
        }

        const block = body ? ` [${eol}${body}${indent}]` : '';
        const propertyText = `${annotationsText}${indent}scalar property ${name}${block}${eol}${eol}`;

        const newContent = insertBeforeClosingBrace(currentText, propertyText);
        await writeFileAndNotify(currentFilePath, currentFileUri, newContent);

        const notes: string[] = [];
        if (missing.length > 0) {
            notes.push(`Auto-added imports for: ${missing.join(', ')}.`);
        }

        const result = {
            content: [
                { type: 'text' as const, text: `✓ Created scalar property "${name}"${notes.length ? '\n' + notes.join(' ') : ''}\n\nGenerated code:\n${propertyText.trim()}` },
            ],
        };

        // Run validation if safe mode is enabled
        const safeMode = preferencesState.getPreferences().safeMode ?? false;
        return appendValidationIfSafeMode(result, currentFileUri, safeMode);
    } catch (error) {
        return {
            isError: true,
            content: [
                { type: 'text' as const, text: `Error creating scalar property: ${error instanceof Error ? error.message : String(error)}` },
            ],
        };
    }
};
