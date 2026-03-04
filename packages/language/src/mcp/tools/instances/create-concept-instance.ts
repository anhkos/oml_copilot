import * as fs from 'fs';
import { z } from 'zod';
import { AnnotationParam, PropertyValueParam, collectImportPrefixes, formatAnnotations, formatLiteral, insertBeforeClosingBrace, normalizeNameCase, stripLocalPrefix, appendValidationIfSafeMode } from '../common.js';
import { annotationParamSchema, propertyValueParamSchema } from '../schemas.js';
import { loadDescriptionDocument, writeDescriptionAndNotify, findInstance, OntologyNotFoundError, WrongOntologyTypeError } from '../description-common.js';
import { resolveSymbolName, createResolutionErrorResult, parseVocabularyForProperties, type OmlSymbolType } from '../query/index.js';
import { preferencesState } from '../preferences/preferences-state.js';
import { ensureImportsHandler } from '../methodology/ensure-imports.js';

const paramsSchema = {
    ontology: z.string().describe('ABSOLUTE file path to a DESCRIPTION ontology file. Use the full path from the open file, e.g., c:/Users/.../file.oml'),
    name: z.string().describe('Instance identifier/name (e.g., "MissionCommander", "R1", "FireFighter"). This is the OML ID for the instance.'),
    types: z.array(z.string()).optional().describe('Concept/aspect types this instance conforms to. Simple or qualified names are auto-resolved; imports are added automatically. Use suggest_oml_symbols only if you need to discover names when resolution fails.'),
    propertyValues: z.array(propertyValueParamSchema).optional().describe('Property value assertions inside the instance block [...]. Includes both scalar properties (use literalValues) and relation assertions (use referencedValues). Example: [{"property": "base:description", "literalValues": [{"type": "quoted", "value": "Mission Commander"}]}, {"property": "requirement:isExpressedBy", "referencedValues": ["Operator"]}]'),
    annotations: z.array(annotationParamSchema).optional().describe('Annotations that appear BEFORE the instance declaration (e.g., @dc:title). For properties INSIDE the instance block, use propertyValues instead.'),
};

export const createConceptInstanceTool = {
    name: 'create_concept_instance' as const,
    description: `Create a concept instance in a DESCRIPTION ontology.

Use this tool only for deterministic file mutation.

Hard constraints:
- Call this tool sequentially (no parallel mutation calls)
- Target must be an existing DESCRIPTION ontology
- If target file does not exist, call create_ontology first

Behavior:
- Resolves simple or qualified type/property names
- Adds missing imports automatically when possible
- Returns clear errors for missing symbols or wrong ontology type`,
    paramsSchema,
};

export const createConceptInstanceMetadata = {
    id: 'create_concept_instance',
    displayName: 'Create Concept Instance',
    layer: 'description' as const,
    severity: 'critical' as const,
    version: '1.0.0',
    shortDescription: 'Create an instance of a concept in a description file',
    description: 'Creates a new concept instance (individual) in a description file with deterministic mutation; methodology orchestration is handled by skill workflow.',
    tags: ['instance-creation', 'description', 'ai-friendly', 'core'],
    dependencies: ['enforce_methodology_rules'],
    addedDate: '2024-01-01',
};

function buildPropertyValues(propVals: PropertyValueParam[] | undefined, indent: string, eol: string): string {
    if (!propVals || propVals.length === 0) return '';
    
    const lines: string[] = [];
    for (const pv of propVals) {
        const values: string[] = [];
        if (pv.literalValues) {
            values.push(...pv.literalValues.map(formatLiteral));
        }
        if (pv.referencedValues) {
            values.push(...pv.referencedValues);
        }
        if (values.length > 0) {
            lines.push(`${indent}${pv.property} ${values.join(', ')}`);
        }
    }
    return lines.join(eol) + (lines.length > 0 ? eol : '');
}

export const createConceptInstanceHandler = async (params: {
    ontology: string;
    name: string;
    types?: string[];
    propertyValues?: PropertyValueParam[];
    annotations?: AnnotationParam[];
}) => {
    const { ontology, name, types } = params;

    try {
        const { description, filePath, fileUri, text, eol, indent } = await loadDescriptionDocument(ontology);

        if (findInstance(description, name)) {
            // Check if instance with the same name already exists - guide to update_instance
            const typesJson = types ? JSON.stringify(types) : '["Type1", "Type2"]';
            return {
                isError: true,
                content: [{
                    type: 'text' as const,
                    text: `\n` +
                        `========================================\n` +
                        `❌ STOP: Instance "${name}" already exists!\n` +
                        `========================================\n\n` +
                        `You CANNOT create it again. To ADD TYPES, you MUST use update_instance.\n\n` +
                        `🔧 CALL THIS EXACT TOOL NOW:\n\n` +
                        `  Tool: update_instance\n` +
                        `  Parameters:\n` +
                        `    ontology: "${ontology}"\n` +
                        `    instance: "${name}"\n` +
                        `    newTypes: ${typesJson}\n\n` +
                        `This will change the instance declaration to include all specified types.\n` +
                        `DO NOT use update_property_value with rdf:type - that will NOT work.\n` +
                        `========================================`
                }],
            };
        }

        // Resolve and VERIFY types - ensure they actually exist in the workspace
        const entityTypes: OmlSymbolType[] = ['concept', 'aspect', 'relation_entity'];
        const resolvedTypes: string[] = [];
        const verifiedTypes: string[] = []; // Track which types were verified
        
        if (types && types.length > 0) {
            for (const t of types) {
                const resolution = await resolveSymbolName(t, fileUri, entityTypes);
                if (!resolution.success) {
                    // Type could not be found in workspace - provide helpful message
                    // Check if it's a "not found" type error (no suggestions = not found)
                    if (!resolution.suggestions || resolution.suggestions.length === 0) {
                        return {
                            isError: true,
                            content: [{
                                type: 'text' as const,
                                text: `Type "${t}" not found in workspace.\n\n` +
                                    `The type you specified does not exist in any imported vocabulary.\n\n` +
                                    `SUGGESTIONS:\n` +
                                    `  1. Use suggest_oml_symbols(uri="${ontology}", symbolType="concept") to discover available types\n` +
                                    `  2. Check if you need to add_import for the vocabulary containing this type\n` +
                                    `  3. Verify the spelling and prefix of the type name\n\n` +
                                    `This verification ensures you're using real concepts from your ontologies, not hallucinated names.`
                            }],
                        };
                    }
                    // Has suggestions = ambiguous, use the standard resolution error
                    return createResolutionErrorResult(resolution, t, 'type');
                }
                resolvedTypes.push(stripLocalPrefix(resolution.qualifiedName!, description.prefix));
                verifiedTypes.push(`${t} → ${resolution.qualifiedName}`);
            }
        }

        // Auto-resolve property names by discovering available properties from type vocabularies
        const autoResolvedProperties: string[] = [];
        if (params.propertyValues && params.propertyValues.length > 0 && resolvedTypes.length > 0) {
            // Get unique vocabulary prefixes from resolved types
            const vocabPrefixes = new Set<string>();
            for (const type of resolvedTypes) {
                if (type.includes(':')) {
                    vocabPrefixes.add(type.split(':')[0]);
                }
            }

            // Try to discover properties from each vocabulary
            const discoveredProps = new Map<string, { qualified: string; vocab: string }>();
            for (const prefix of vocabPrefixes) {
                // Find the vocabulary file from imports
                const importMatch = text.match(new RegExp(`extends\\s+<([^>]+)>\\s+as\\s+${prefix}\\b`, 'i'));
                if (importMatch) {
                    const vocabUri = importMatch[1];
                    try {
                        // Convert URI to file path (simple approach - assumes file:// scheme)
                        const vocabPath = vocabUri.replace('file://', '').replace('file:', '');
                        const props = await parseVocabularyForProperties(vocabPath);
                        
                        // Index all properties by simple name (case-insensitive)
                        for (const rel of props.relations) {
                            const simpleName = rel.name.toLowerCase();
                            discoveredProps.set(simpleName, { qualified: `${prefix}:${rel.name}`, vocab: prefix });
                            if (rel.reverseName) {
                                const reverseSimple = rel.reverseName.toLowerCase();
                                discoveredProps.set(reverseSimple, { qualified: `${prefix}:${rel.reverseName}`, vocab: prefix });
                            }
                        }
                        for (const scalar of props.scalarProperties) {
                            const simpleName = scalar.name.toLowerCase();
                            discoveredProps.set(simpleName, { qualified: `${prefix}:${scalar.name}`, vocab: prefix });
                        }
                    } catch (e) {
                        // Ignore parsing errors - fall back to regular resolution
                        console.error(`[create_concept_instance] Failed to parse vocabulary for ${prefix}:`, e);
                    }
                }
            }

            // Auto-resolve simple property names
            for (const pv of params.propertyValues) {
                const prop = pv.property;
                // Skip already-qualified properties
                if (prop.includes(':')) {
                    continue;
                }
                
                // Try to find match in discovered properties
                const match = discoveredProps.get(prop.toLowerCase());
                if (match) {
                    pv.property = match.qualified;
                    autoResolvedProperties.push(`${prop} → ${match.qualified}`);
                }
            }
        }

        // Verify properties exist as well
        // Properties can be scalar properties, annotation properties, OR relations (unreified, forward, reverse)
        const propertyTypes: OmlSymbolType[] = ['scalar_property', 'annotation_property', 'unreified_relation', 'forward_relation', 'reverse_relation'];
        const verifiedProperties: string[] = [];
        
        if (params.propertyValues && params.propertyValues.length > 0) {
            for (const pv of params.propertyValues) {
                // Skip base: properties as they're standard
                if (pv.property.startsWith('base:') || pv.property.startsWith('dc:') || pv.property.startsWith('xsd:')) {
                    continue;
                }
                const resolution = await resolveSymbolName(pv.property, fileUri, propertyTypes);
                if (!resolution.success && (!resolution.suggestions || resolution.suggestions.length === 0)) {
                    return {
                        isError: true,
                        content: [{
                            type: 'text' as const,
                            text: `❌ Property "${pv.property}" not found in workspace.\n\n` +
                                `The property you specified does not exist in any imported vocabulary.\n\n` +
                                `💡 SUGGESTIONS:\n` +
                                `  1. Use suggest_oml_symbols(uri="${ontology}", symbolType="scalar_property") to discover scalar properties\n` +
                                `  2. Use suggest_oml_symbols(uri="${ontology}", symbolType="unreified_relation") to discover relations (including reverse relations)\n` +
                                `  3. Check if you need to add_import for the vocabulary containing this property/relation\n` +
                                `  4. Verify the spelling and prefix of the name\n\n` +
                                `This verification ensures you're using real properties from your ontologies.`
                        }],
                    };
                }
                if (resolution.success) {
                    verifiedProperties.push(`${pv.property} → ${resolution.qualifiedName}`);
                }
            }
        }

        // Collect existing and referenced prefixes, make sure all are imported with case-normalized names
        const existingPrefixes = collectImportPrefixes(text, description.prefix);
        const referencedPrefixes = new Set<string>();

        const normalizedTypes = resolvedTypes.map((t) => {
            if (t.includes(':')) {
                referencedPrefixes.add(t.split(':')[0]);
            }
            const norm = normalizeNameCase(t);
            return norm;
        });

        let workingPropertyValues: PropertyValueParam[] | undefined = params.propertyValues ? [...params.propertyValues] : undefined;

        for (const pv of workingPropertyValues ?? []) {
            if (pv.property.includes(':')) {
                referencedPrefixes.add(pv.property.split(':')[0]);
            }
            if (pv.referencedValues) {
                for (const rv of pv.referencedValues) {
                    if (rv.includes(':')) {
                        referencedPrefixes.add(rv.split(':')[0]);
                    }
                }
            }
        }

        let workingAnnotations: AnnotationParam[] | undefined = params.annotations ? [...params.annotations] : undefined;

        if (workingAnnotations && workingAnnotations.length > 0) {
            const kept: AnnotationParam[] = [];
            const descValues: PropertyValueParam['literalValues'] = [];
            for (const ann of workingAnnotations) {
                if (ann.property === 'base:description' || ann.property === 'dc:description') {
                    if (ann.literalValues) {
                        descValues.push(...ann.literalValues);
                    }
                    // ignore referencedValues for description annotations
                } else {
                    kept.push(ann);
                }
                if (ann.property.includes(':')) {
                    referencedPrefixes.add(ann.property.split(':')[0]);
                }
            }
            if (descValues.length > 0) {
                const hasExistingDesc = (workingPropertyValues ?? []).some((pv) => pv.property === 'base:description');
                if (!hasExistingDesc) {
                    workingPropertyValues = [...(workingPropertyValues ?? []), { property: 'base:description', literalValues: descValues }];
                }
            }
            workingAnnotations = kept;
        }

        for (const ann of workingAnnotations ?? []) {
            if (ann.property.includes(':')) {
                referencedPrefixes.add(ann.property.split(':')[0]);
            }
        }

        const missing = [...referencedPrefixes].filter((p) => !existingPrefixes.has(p));
        
        // Auto-add missing imports instead of returning an error
        let currentText = text;
        let currentFilePath = filePath;
        let currentFileUri = fileUri;
        
        if (missing.length > 0) {
            // Automatically call ensure_imports to add the missing imports
            const ensureResult = await ensureImportsHandler({ ontology });
            
            if (ensureResult.isError) {
                // If ensure_imports fails, return its error
                return ensureResult;
            }
            
            // Reload the document to get the updated content with new imports
            const reloaded = await loadDescriptionDocument(ontology);
            currentText = reloaded.text;
            currentFilePath = reloaded.filePath;
            currentFileUri = reloaded.fileUri;
        }

        const innerIndent = indent + indent;
        const annotationsText = formatAnnotations(workingAnnotations, indent, eol);

        const typeClause = normalizedTypes.length > 0 ? ` : ${normalizedTypes.map((t) => t.normalized).join(', ')}` : '';
        const propText = buildPropertyValues(workingPropertyValues, innerIndent, eol);
        const block = propText ? ` [${eol}${propText}${indent}]` : '';

        const instanceText = `${annotationsText}${indent}instance ${name}${typeClause}${block}${eol}${eol}`;
        const newContent = insertBeforeClosingBrace(currentText, instanceText);
        await writeDescriptionAndNotify(currentFilePath, currentFileUri, newContent);

        // Verify the instance was persisted (guards against stale writes or editor race conditions)
        const instanceRegex = new RegExp(`\\binstance\\s+${name}\\b`);
        let persistedText = fs.readFileSync(currentFilePath, 'utf-8');
        if (!instanceRegex.test(persistedText)) {
            // Retry once against the latest file contents
            const retryContent = insertBeforeClosingBrace(persistedText, instanceText);
            await writeDescriptionAndNotify(currentFilePath, currentFileUri, retryContent);
            persistedText = fs.readFileSync(currentFilePath, 'utf-8');
            if (!instanceRegex.test(persistedText)) {
                return {
                    isError: true,
                    content: [{
                        type: 'text' as const,
                        text: `❌ WRITE VERIFICATION FAILED\n\n` +
                            `The instance "${name}" did not appear in the file after two write attempts.\n` +
                            `This can happen if the file is open with unsaved changes or another process overwrote the file.\n\n` +
                            `🔧 ACTION REQUIRED:\n` +
                            `  1. Save and close the file in the editor\n` +
                            `  2. Retry create_concept_instance for "${name}"\n` +
                            `  3. If it keeps happening, restart the MCP server and VS Code`
                    }],
                };
            }
        }

        const notes: string[] = [];
        if (missing.length > 0) {
            notes.push(`Auto-added imports for: ${missing.join(', ')}.`);
        }
        const changedTypes = normalizedTypes.filter((t) => t.changed).map((t) => t.normalized);
        if (changedTypes.length) {
            notes.push(`Normalized type names: ${changedTypes.join(', ')}.`);
        }

        const result = {
            content: [
                { type: 'text' as const, text: `✓ Created concept instance "${name}"` },
                ...(notes.length ? [{ type: 'text' as const, text: notes.join(' ') }] : []),
                ...(verifiedTypes.length ? [{ type: 'text' as const, text: `✓ Verified types: ${verifiedTypes.join(', ')}` }] : []),
                ...(autoResolvedProperties.length ? [{ type: 'text' as const, text: `✓ Auto-resolved properties: ${autoResolvedProperties.join(', ')}` }] : []),
            ],
        };

        // Run validation if safe mode is enabled
        const safeMode = preferencesState.getPreferences().safeMode ?? false;
        return appendValidationIfSafeMode(result, fileUri, safeMode);
    } catch (error) {
        // Handle specific error types with helpful guidance
        if (error instanceof OntologyNotFoundError) {
            return {
                isError: true,
                content: [{
                    type: 'text' as const,
                    text: `❌ STOP - ONTOLOGY NOT FOUND: ${error.filePath}\n\n` +
                        `The description file does not exist yet.\n\n` +
                        `⛔ DO NOT manually create this file. DO NOT use create_file or any file creation tool.\n` +
                        `⛔ DO NOT call multiple tools in parallel.\n\n` +
                        `🔧 ACTION REQUIRED (call these tools SEQUENTIALLY, waiting for each to complete):\n` +
                        `  STEP 1: create_ontology(filePath="${error.filePath}", kind="description", namespace="...", prefix="...")\n` +
                        `  STEP 2: add_import(ontology="${error.filePath}", targetOntologyPath="path/to/vocabulary.oml")\n` +
                        `  STEP 3: create_concept_instance(ontology="${error.filePath}", name="${name}", types=[...])\n\n` +
                        `Call create_ontology NOW. Wait for it to complete. Then proceed to add_import.`
                }],
            };
        }
        
        if (error instanceof WrongOntologyTypeError) {
            // If the file exists but is empty, instruct to initialize it with create_ontology
            try {
                const existingText = fs.readFileSync(error.filePath, 'utf-8');
                if (existingText.trim().length === 0) {
                    return {
                        isError: true,
                        content: [{
                            type: 'text' as const,
                            text: `❌ STOP - EMPTY FILE: ${error.filePath}\n\n` +
                                `The target file exists but is empty. Initialize it as a DESCRIPTION ontology first.\n\n` +
                                `⛔ DO NOT manually write to this file. DO NOT use create_file or replace_string_in_file.\n` +
                                `⛔ DO NOT call multiple tools in parallel.\n\n` +
                                `🔧 ACTION REQUIRED (call these tools SEQUENTIALLY, waiting for each to complete):\n` +
                                `  STEP 1: create_ontology(filePath="${error.filePath}", kind="description", namespace="...", prefix="...")\n` +
                                `  STEP 2: add_import(ontology="${error.filePath}", targetOntologyPath="path/to/vocabulary.oml")\n` +
                                `  STEP 3: create_concept_instance(ontology="${error.filePath}", name="${name}", types=[...])\n\n` +
                                `Call create_ontology NOW with this exact filePath. Wait for it to complete. Then proceed.`
                        }],
                    };
                }
            } catch {
                // Fall through to the generic wrong-type message
            }
            return {
                isError: true,
                content: [{
                    type: 'text' as const,
                    text: `❌ WRONG ONTOLOGY TYPE: Expected "description" but found "${error.actualType}"\n\n` +
                        `Instances can only be created in DESCRIPTION files, not vocabularies.\n\n` +
                        `💡 SUGGESTIONS:\n` +
                        `  - Create a new description file for your instances\n` +
                        `  - Use create_ontology with kind="description"\n` +
                        `  - Vocabularies define types (concepts, relations); descriptions instantiate them`
                }],
            };
        }
        
        return {
            isError: true,
            content: [{ type: 'text' as const, text: `Error creating concept instance: ${error instanceof Error ? error.message : String(error)}` }],
        };
    }
};
