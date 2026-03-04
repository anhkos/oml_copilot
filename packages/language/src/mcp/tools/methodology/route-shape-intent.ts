import * as fs from 'fs';
import * as path from 'path';
import rdf from '@zazuko/env-node';
import { z } from 'zod';
import { URI } from 'langium';
import { resolveWorkspacePath } from '../common.js';
import { propertyValueParamSchema } from '../schemas.js';
import { resolveSymbolName, type OmlSymbolType } from '../query/index.js';
import { createConceptInstanceHandler } from '../instances/create-concept-instance.js';
import { enforceMethodologyRulesHandler } from './enforce-methodology-rules.js';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const SH_NODE_SHAPE = 'http://www.w3.org/ns/shacl#NodeShape';
const SH_TARGET_CLASS = 'http://www.w3.org/ns/shacl#targetClass';
const SH_PROPERTY = 'http://www.w3.org/ns/shacl#property';
const SH_PATH = 'http://www.w3.org/ns/shacl#path';
const SH_MIN_COUNT = 'http://www.w3.org/ns/shacl#minCount';
const SH_NAME = 'http://www.w3.org/ns/shacl#name';

type PropertyValueParam = {
    property: string;
    literalValues?: Array<{
        type: 'integer' | 'decimal' | 'double' | 'boolean' | 'quoted';
        value: string | number | boolean;
        scalarType?: string;
        langTag?: string;
    }>;
    referencedValues?: string[];
    containedValues?: unknown;
};

type ShapePropertyCapability = {
    propertyIri: string;
    localName: string;
    required: boolean;
    minCount?: number;
};

type ShapeCapability = {
    shapeIri: string;
    shapeLabel?: string;
    targetClassIri: string;
    targetClassLocalName: string;
    requiredProperties: ShapePropertyCapability[];
    score: number;
};

const paramsSchema = {
    intent: z.string().describe('Natural-language modeling intent, e.g., "add stakeholder".'),
    descriptionPath: z.string().describe('Path to target OML description file.'),
    shapesPath: z.string().optional().describe('Optional explicit SHACL shapes path; auto-discovered when omitted.'),
    instanceName: z.string().optional().describe('Instance name to create when execute=true.'),
    propertyValues: z.array(propertyValueParamSchema).optional().describe('Optional property assertions for execute mode.'),
    execute: z.boolean().optional().describe('If true, executes the planned mutation. If false, returns plan only.'),
    maxCandidates: z.number().optional().describe('Maximum shape candidates to include (default: 5).'),
};

export const routeShapeIntentTool = {
    name: 'route_shape_intent' as const,
    description: `Route natural-language modeling intents using SHACL shapes only (no playbook dependency).

Use this in workflowMode "methodology" to keep generic tools while remaining methodology-aware.

Behavior:
- Discovers SHACL shape capabilities (target class + required properties)
- Matches user intent to best candidate shapes
- Produces an execution plan using generic OML tools
- Optionally executes create_concept_instance + enforce_methodology_rules`,
    paramsSchema,
};

export const routeShapeIntentAliasTool = {
    name: 'route-shape-intent' as const,
    description: `Alias for route_shape_intent (hyphenated name for compatibility with some model/tool naming patterns).

Use this exactly like route_shape_intent.`,
    paramsSchema,
};

export const routeShapeIntentMetadata = {
    id: 'route_shape_intent',
    displayName: 'Route Shape Intent',
    layer: 'methodology' as const,
    severity: 'high' as const,
    version: '0.1.0',
    shortDescription: 'Shape-driven intent routing for methodology-aware coding',
    description: 'Builds and optionally executes generic modeling plans by matching intents to SHACL shape capabilities.',
    tags: ['methodology', 'shacl', 'intent-routing', 'planning'],
    dependencies: ['create_concept_instance', 'enforce_methodology_rules'],
    addedDate: '2026-03-03',
};

function localNameFromIri(iri: string): string {
    const hash = iri.lastIndexOf('#');
    const slash = iri.lastIndexOf('/');
    const idx = Math.max(hash, slash);
    return idx >= 0 ? iri.slice(idx + 1) : iri;
}

function tokenize(text: string): string[] {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .split(/\s+/)
        .filter(Boolean);
}

function scoreCapability(intent: string, capability: ShapeCapability): number {
    const intentTokens = new Set(tokenize(intent));
    const classTokens = tokenize(capability.targetClassLocalName);
    const labelTokens = tokenize(capability.shapeLabel || '');
    const aliasTokens = new Set([...classTokens, ...labelTokens]);

    let score = 0;
    const targetLower = capability.targetClassLocalName.toLowerCase();
    const labelLower = (capability.shapeLabel || '').toLowerCase();
    const intentLower = intent.toLowerCase();

    if (intentLower.includes(targetLower)) {
        score += 8;
    }
    if (labelLower && intentLower.includes(labelLower)) {
        score += 6;
    }

    for (const token of intentTokens) {
        if (aliasTokens.has(token)) {
            score += 2;
        }
    }

    if (intentLower.startsWith('add ') || intentLower.startsWith('create ')) {
        score += 1;
    }

    return score;
}

function toNumber(value: string): number | undefined {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function resolveShapesPath(params: { explicitShapesPath?: string; descriptionPath: string }): string | null {
    const collectAncestorDirs = (startDir: string): string[] => {
        const dirs: string[] = [];
        let current = path.resolve(startDir);
        while (true) {
            dirs.push(current);
            const parent = path.dirname(current);
            if (parent === current) {
                break;
            }
            current = parent;
        }
        return dirs;
    };

    const ancestorDirs = collectAncestorDirs(path.dirname(params.descriptionPath));

    const tryResolveCandidate = (candidate: string): string | null => {
        const trimmed = candidate.trim();
        if (!trimmed) {
            return null;
        }

        if (path.isAbsolute(trimmed) && fs.existsSync(trimmed)) {
            return trimmed;
        }

        const workspaceResolved = resolveWorkspacePath(trimmed);
        if (fs.existsSync(workspaceResolved)) {
            return workspaceResolved;
        }

        const fromDescriptionDir = path.resolve(path.dirname(params.descriptionPath), trimmed);
        if (fs.existsSync(fromDescriptionDir)) {
            return fromDescriptionDir;
        }

        for (const ancestorDir of ancestorDirs) {
            const fromAncestor = path.resolve(ancestorDir, trimmed);
            if (fs.existsSync(fromAncestor)) {
                return fromAncestor;
            }
        }

        return null;
    };

    const extractAnnotationShapeCandidates = (descriptionPath: string): string[] => {
        try {
            const text = fs.readFileSync(descriptionPath, 'utf-8');
            const lines = text.split(/\r?\n/);
            const candidates: string[] = [];

            const shapeKeyPattern = /@(\w+:)?(shaclshapes|shapespath|shaclshape|shape|relation|source|references)\b/i;
            const quotedPathPattern = /["']([^"']+\.(ttl|nt|nq|trig)|[^"']*[\\/]shapes[\\/][^"']+)["']/ig;

            for (const line of lines) {
                if (!shapeKeyPattern.test(line)) {
                    continue;
                }

                let match: RegExpExecArray | null;
                while ((match = quotedPathPattern.exec(line)) !== null) {
                    const value = match[1]?.trim();
                    if (value) {
                        candidates.push(value);
                    }
                }
            }

            return candidates;
        } catch {
            return [];
        }
    };

    if (params.explicitShapesPath) {
        const explicit = tryResolveCandidate(params.explicitShapesPath);
        if (explicit) {
            return explicit;
        }
    }

    const annotationCandidates = extractAnnotationShapeCandidates(params.descriptionPath);
    for (const candidate of annotationCandidates) {
        const resolved = tryResolveCandidate(candidate);
        if (resolved) {
            return resolved;
        }
    }

    const descriptionBaseName = path.basename(params.descriptionPath, path.extname(params.descriptionPath));
    const descriptionDir = path.dirname(params.descriptionPath);
    const extensions = ['.ttl', '.nt', '.nq', '.trig'];
    const workspaceShapesDir = resolveWorkspacePath('shapes');

    const candidatePaths: string[] = [];
    for (const extension of extensions) {
        candidatePaths.push(path.join(descriptionDir, 'shapes', `${descriptionBaseName}${extension}`));
        candidatePaths.push(path.join(descriptionDir, 'shapes', `${descriptionBaseName}-shapes${extension}`));
        candidatePaths.push(path.join(descriptionDir, 'shapes', `${descriptionBaseName}.shapes${extension}`));
        candidatePaths.push(path.join(workspaceShapesDir, `${descriptionBaseName}${extension}`));
        candidatePaths.push(path.join(workspaceShapesDir, `${descriptionBaseName}-shapes${extension}`));
        candidatePaths.push(path.join(workspaceShapesDir, `${descriptionBaseName}.shapes${extension}`));

        for (const ancestorDir of ancestorDirs) {
            candidatePaths.push(path.join(ancestorDir, 'shapes', `${descriptionBaseName}${extension}`));
            candidatePaths.push(path.join(ancestorDir, 'shapes', `${descriptionBaseName}-shapes${extension}`));
            candidatePaths.push(path.join(ancestorDir, 'shapes', `${descriptionBaseName}.shapes${extension}`));
        }
    }

    return candidatePaths.find((candidatePath) => fs.existsSync(candidatePath)) || null;
}

async function extractShapeCapabilities(shapesPath: string, intent: string): Promise<ShapeCapability[]> {
    const shapes = await rdf.dataset().import(rdf.fromFile(shapesPath));
    const capabilities: ShapeCapability[] = [];

    for (const quad of shapes.match(null, rdf.namedNode(RDF_TYPE), rdf.namedNode(SH_NODE_SHAPE))) {
        const shapeTerm = quad.subject;
        const shapeIri = shapeTerm.value;

        const targetClasses = [...shapes.match(shapeTerm, rdf.namedNode(SH_TARGET_CLASS), null)]
            .map((entry) => entry.object)
            .filter((term) => term.termType === 'NamedNode')
            .map((term) => term.value);

        if (targetClasses.length === 0) {
            continue;
        }

        const shapeLabelQuad = [...shapes.match(shapeTerm, rdf.namedNode(SH_NAME), null)][0]
            || [...shapes.match(shapeTerm, rdf.namedNode(RDFS_LABEL), null)][0];
        const shapeLabel = shapeLabelQuad?.object?.value;

        const requiredProperties: ShapePropertyCapability[] = [];
        const propertyNodes = [...shapes.match(shapeTerm, rdf.namedNode(SH_PROPERTY), null)].map((entry) => entry.object);
        for (const propertyNode of propertyNodes) {
            const pathQuad = [...shapes.match(propertyNode, rdf.namedNode(SH_PATH), null)][0];
            if (!pathQuad || pathQuad.object.termType !== 'NamedNode') {
                continue;
            }

            const minCountQuad = [...shapes.match(propertyNode, rdf.namedNode(SH_MIN_COUNT), null)][0];
            const minCount = minCountQuad ? toNumber(minCountQuad.object.value) : undefined;

            requiredProperties.push({
                propertyIri: pathQuad.object.value,
                localName: localNameFromIri(pathQuad.object.value),
                required: (minCount ?? 0) >= 1,
                minCount,
            });
        }

        for (const targetClassIri of targetClasses) {
            const capability: ShapeCapability = {
                shapeIri,
                shapeLabel,
                targetClassIri,
                targetClassLocalName: localNameFromIri(targetClassIri),
                requiredProperties: requiredProperties.filter((prop) => prop.required),
                score: 0,
            };
            capability.score = scoreCapability(intent, capability);
            capabilities.push(capability);
        }
    }

    capabilities.sort((a, b) => b.score - a.score || a.targetClassLocalName.localeCompare(b.targetClassLocalName));
    return capabilities;
}

function textContent(result: { content: Array<{ type: 'text'; text: string }> }): string {
    return result.content.map((entry) => entry.text).join('\n');
}

export const routeShapeIntentHandler = async (params: {
    intent: string;
    descriptionPath: string;
    shapesPath?: string;
    instanceName?: string;
    propertyValues?: PropertyValueParam[];
    execute?: boolean;
    maxCandidates?: number;
}): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> => {
    try {
        const execute = params.execute ?? false;
        const maxCandidates = params.maxCandidates ?? 5;
        const resolvedDescriptionPath = path.isAbsolute(params.descriptionPath)
            ? params.descriptionPath
            : resolveWorkspacePath(params.descriptionPath);

        if (!fs.existsSync(resolvedDescriptionPath)) {
            return {
                isError: true,
                content: [{ type: 'text', text: `Description not found: ${resolvedDescriptionPath}` }],
            };
        }

        const resolvedShapesPath = resolveShapesPath({
            explicitShapesPath: params.shapesPath,
            descriptionPath: resolvedDescriptionPath,
        });

        if (!resolvedShapesPath) {
            return {
                isError: true,
                content: [{ type: 'text', text: 'Could not resolve SHACL shapes file. Provide shapesPath or add a matching file under shapes/.' }],
            };
        }

        const capabilities = await extractShapeCapabilities(resolvedShapesPath, params.intent);
        if (capabilities.length === 0) {
            return {
                isError: true,
                content: [{ type: 'text', text: `No SHACL NodeShape capabilities found in: ${resolvedShapesPath}` }],
            };
        }

        const candidates = capabilities.slice(0, Math.max(1, maxCandidates));
        const best = candidates[0];
        const descriptionUri = URI.file(resolvedDescriptionPath).toString();

        const entityTypes: OmlSymbolType[] = ['concept', 'aspect', 'relation_entity'];
        const typeResolution = await resolveSymbolName(best.targetClassLocalName, descriptionUri, entityTypes);

        const resolvedProperties: Array<{ source: string; resolved?: string }> = [];
        for (const req of best.requiredProperties) {
            const propertyTypes: OmlSymbolType[] = ['scalar_property', 'annotation_property', 'unreified_relation', 'forward_relation', 'reverse_relation'];
            const propertyResolution = await resolveSymbolName(req.localName, descriptionUri, propertyTypes);
            resolvedProperties.push({
                source: req.localName,
                resolved: propertyResolution.success ? propertyResolution.qualifiedName : undefined,
            });
        }

        const plan = {
            mode: execute ? 'execute' : 'plan',
            intent: params.intent,
            descriptionPath: resolvedDescriptionPath,
            shapesPath: resolvedShapesPath,
            selectedShape: {
                shapeIri: best.shapeIri,
                shapeLabel: best.shapeLabel,
                targetClassIri: best.targetClassIri,
                targetClassLocalName: best.targetClassLocalName,
                score: best.score,
            },
            createStep: {
                tool: 'create_concept_instance',
                ontology: resolvedDescriptionPath,
                name: params.instanceName || '<provide-instanceName>',
                types: [typeResolution.success ? typeResolution.qualifiedName : best.targetClassLocalName],
                propertyValues: params.propertyValues || [],
            },
            requiredPropertiesFromShape: best.requiredProperties.map((prop) => ({
                propertyIri: prop.propertyIri,
                localName: prop.localName,
                minCount: prop.minCount,
                resolvedProperty: resolvedProperties.find((entry) => entry.source === prop.localName)?.resolved,
            })),
            validateStep: {
                tool: 'enforce_methodology_rules',
                descriptionPath: resolvedDescriptionPath,
                shapesPath: resolvedShapesPath,
            },
            candidateShapes: candidates.map((candidate) => ({
                targetClass: candidate.targetClassLocalName,
                shapeLabel: candidate.shapeLabel,
                score: candidate.score,
            })),
        };

        if (!execute) {
            return {
                content: [{ type: 'text', text: JSON.stringify(plan, null, 2) }],
            };
        }

        if (!params.instanceName) {
            return {
                isError: true,
                content: [{ type: 'text', text: `${JSON.stringify(plan, null, 2)}\n\nExecution requires instanceName.` }],
            };
        }

        if (!typeResolution.success) {
            return {
                isError: true,
                content: [{ type: 'text', text: `${JSON.stringify(plan, null, 2)}\n\nCould not resolve target class "${best.targetClassLocalName}" in current workspace/import context.` }],
            };
        }

        const createResult = await createConceptInstanceHandler({
            ontology: resolvedDescriptionPath,
            name: params.instanceName,
            types: [typeResolution.qualifiedName!],
            propertyValues: params.propertyValues,
        });

        if (createResult.isError) {
            return {
                isError: true,
                content: [{ type: 'text', text: `${JSON.stringify(plan, null, 2)}\n\nCreate step failed:\n${textContent(createResult)}` }],
            };
        }

        const enforcementResult = await enforceMethodologyRulesHandler({
            descriptionPath: resolvedDescriptionPath,
            shapesPath: resolvedShapesPath,
        });

        return {
            content: [{
                type: 'text',
                text: [
                    'Execution summary:',
                    JSON.stringify(plan, null, 2),
                    '',
                    'Create step output:',
                    textContent(createResult),
                    '',
                    'Methodology enforcement output:',
                    textContent(enforcementResult),
                ].join('\n'),
            }],
            isError: enforcementResult.isError,
        };
    } catch (error) {
        return {
            isError: true,
            content: [{ type: 'text', text: `Error routing shape intent: ${error instanceof Error ? error.message : String(error)}` }],
        };
    }
};
