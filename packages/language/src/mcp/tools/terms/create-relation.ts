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
import { buildFromToLines, buildForwardReverse, buildRelationFlags } from './text-builders.js';
import { preferencesState } from '../preferences/preferences-state.js';
import { resolveSymbolName, createResolutionErrorResult, type OmlSymbolType } from '../query/index.js';
import { ensureImportsHandler } from '../methodology/ensure-imports.js';

const paramsSchema = {
    ontology: z.string().describe('ABSOLUTE path to an EXISTING vocabulary file. If the file does not exist yet, call create_ontology(kind="vocabulary") first.'),
    name: z.string().describe('Relation name to create'),
    sources: z.array(z.string()).optional().describe('Source entities. Simple or qualified names are auto-resolved; imports are added automatically. Use suggest_oml_symbols only if you need to discover names when resolution fails.'),
    targets: z.array(z.string()).optional().describe('Target entities. Simple or qualified names are auto-resolved; imports are added automatically. Use suggest_oml_symbols only if you need to discover names when resolution fails.'),
    reverseName: z.string().optional().describe('Reverse role name'),
    functional: z.boolean().optional(),
    inverseFunctional: z.boolean().optional(),
    symmetric: z.boolean().optional(),
    asymmetric: z.boolean().optional(),
    reflexive: z.boolean().optional(),
    irreflexive: z.boolean().optional(),
    transitive: z.boolean().optional(),
    annotations: z.array(annotationParamSchema).optional(),
};

export const createRelationTool = {
    name: 'create_relation' as const,
    description: `[DEFAULT - USE THIS FOR ALL RELATIONS] Creates a relation between entities. This is the standard and recommended way to define relationships in OML. ALWAYS use this tool for creating relations unless the user explicitly requests a "relation entity". Relations have from/to entities and an optional reverse name.

Auto-resolves simple or qualified sources/targets and adds missing imports. If a name is ambiguous, you'll be prompted to disambiguate; use suggest_oml_symbols only as a last resort to discover names.

Always try to include a reverseName for better readability and navigation in tools, and ask the user to specify any other flags if needed. `,
    paramsSchema,
};

export const createRelationMetadata = {
    id: 'create_relation',
    displayName: 'Create Relation',
    layer: 'vocabulary' as const,
    severity: 'critical' as const,
    version: '1.0.0',
    shortDescription: 'Create a relation (unreified) between entities',
    description: 'Creates a new relation between entities in a vocabulary file. This is the default way to define relationships. Include a reverseName for bidirectional navigation.',
    tags: ['relation-definition', 'unreified-relation', 'vocabulary', 'relationship'],
    dependencies: [],
    addedDate: '2024-01-01',
};

// Keep the old name as an alias for backwards compatibility
export const createUnreifiedRelationTool = createRelationTool;

export const createRelationHandler = async (
    params: {
        ontology: string;
        name: string;
        sources?: string[];
        targets?: string[];
        reverseName?: string;
        functional?: boolean;
        inverseFunctional?: boolean;
        symmetric?: boolean;
        asymmetric?: boolean;
        reflexive?: boolean;
        irreflexive?: boolean;
        transitive?: boolean;
        annotations?: AnnotationParam[];
    }
) => {
    const {
        ontology,
        name,
        sources,
        targets,
        reverseName,
        functional,
        inverseFunctional,
        symmetric,
        asymmetric,
        reflexive,
        irreflexive,
        transitive,
        annotations,
    } = params;

    try {
        const { vocabulary, filePath, fileUri, text, eol, indent } = await loadVocabularyDocument(ontology);

        // Resolve sources and targets - support both simple names and qualified names
        const entityTypes: OmlSymbolType[] = ['concept', 'aspect', 'relation_entity'];
        const resolvedSources: string[] = [];
        const resolvedTargets: string[] = [];
        const allQualifiedNames: string[] = []; // Track all qualified names for import detection
        
        if (sources && sources.length > 0) {
            for (const src of sources) {
                const resolution = await resolveSymbolName(src, fileUri, entityTypes);
                if (!resolution.success) {
                    return createResolutionErrorResult(resolution, src, 'source entity');
                }
                const qualified = resolution.qualifiedName!;
                allQualifiedNames.push(qualified);
                resolvedSources.push(stripLocalPrefix(qualified, vocabulary.prefix));
            }
        }
        
        if (targets && targets.length > 0) {
            for (const tgt of targets) {
                const resolution = await resolveSymbolName(tgt, fileUri, entityTypes);
                if (!resolution.success) {
                    return createResolutionErrorResult(resolution, tgt, 'target entity');
                }
                const qualified = resolution.qualifiedName!;
                allQualifiedNames.push(qualified);
                resolvedTargets.push(stripLocalPrefix(qualified, vocabulary.prefix));
            }
        }

        // Collect all referenced prefixes from fully qualified names and annotations
        const allReferencedNames = [
            ...allQualifiedNames, // Use original qualified names before stripping
            ...(annotations?.map(a => a.property) ?? []),
        ];
        const referencedPrefixes = new Set<string>();
        for (const ref of allReferencedNames) {
            if (ref.includes(':')) {
                referencedPrefixes.add(ref.split(':')[0]);
            }
        }

        // Check which prefixes are missing (for reporting purposes)
        const existingPrefixes = collectImportPrefixes(text, vocabulary.prefix);
        const missing = [...referencedPrefixes].filter(p => !existingPrefixes.has(p));

        if (findTerm(vocabulary, name)) {
            return {
                isError: true,
                content: [
                    { type: 'text' as const, text: `Relation "${name}" already exists in the vocabulary.` },
                ],
            };
        }

        const innerIndent = indent + indent;
        const annotationsText = formatAnnotations(annotations, indent, eol);

        let body = '';
        body += buildFromToLines(resolvedSources.length > 0 ? resolvedSources : undefined, resolvedTargets.length > 0 ? resolvedTargets : undefined, innerIndent, eol);
        body += buildForwardReverse(undefined, reverseName, innerIndent, eol);
        body += buildRelationFlags(
            { functional, inverseFunctional, symmetric, asymmetric, reflexive, irreflexive, transitive },
            innerIndent,
            eol
        );

        const block = body ? ` [${eol}${body}${indent}]` : '';
        const relationText = `${annotationsText}${indent}relation ${name}${block}${eol}${eol}`;

        // Write the relation first
        const newContent = insertBeforeClosingBrace(text, relationText);
        await writeFileAndNotify(filePath, fileUri, newContent);

        // Now call ensureImportsHandler to add missing imports
        // It will scan the updated file text and find the new prefixes
        if (missing.length > 0) {
            const ensureResult = await ensureImportsHandler({ ontology });
            if (ensureResult.isError) {
                // Log but don't fail - the relation was created successfully
                console.error('Warning: Failed to auto-add imports:', ensureResult.content);
            }
        }

        const notes: string[] = [];
        if (missing.length > 0) {
            notes.push(`Auto-added imports for: ${missing.join(', ')}.`);
        }

        const result = {
            content: [
                { type: 'text' as const, text: `✓ Created relation "${name}"${notes.length ? '\n' + notes.join(' ') : ''}\n\nGenerated code:\n${relationText.trim()}` },
            ],
        };

        // Run validation if safe mode is enabled
        const safeMode = preferencesState.getPreferences().safeMode ?? false;
        return appendValidationIfSafeMode(result, fileUri, safeMode);
    } catch (error) {
        return {
            isError: true,
            content: [
                { type: 'text' as const, text: `Error creating relation: ${error instanceof Error ? error.message : String(error)}` },
            ],
        };
    }
};

// Keep the old names as aliases for backwards compatibility
export const createUnreifiedRelationHandler = createRelationHandler;