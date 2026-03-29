import { z } from 'zod';
import type { PropertyConstraint } from '../../shacl/types.js';
import { createConceptInstanceHandler } from '../instances/create-concept-instance.js';
import {
    ensureShapeCache,
    findShapeByTargetClass,
    resolveOntologyPath,
    toPropertyValueParam,
    validatePropertyValue,
    validateRequiredAndKnownProperties,
} from './shape-shared.js';

export const addInstanceTool = {
    name: 'add_instance' as const,
    description: 'Create an instance through SHACL validation. This wrapper enforces shape constraints before delegating to create_concept_instance.',
    paramsSchema: {
        targetClass: z.string().describe('Target class (e.g., mission:Objective) from the shapes that are contained in the .md files under the src/md'),
        instanceName: z.string().describe('New instance name.'),
        properties: z.record(z.any()).describe('Property map keyed by SHACL path, e.g. {"base:description": "..."}.'),
        ontology: z.string().optional().describe('Absolute or workspace-relative description ontology path.'),
        contextUri: z.string().optional().describe('The description model that the instance is placed in.'),
    },
};

export const addInstanceMetadata = {
    id: 'add_instance',
    displayName: 'Add Instance (SHACL)',
    layer: 'description' as const,
    severity: 'critical' as const,
    version: '1.0.0',
    shortDescription: 'Constraint-aware create instance wrapper',
    description: 'Validates against SHACL then delegates to create_concept_instance for deterministic file mutation.',
    tags: ['shacl', 'create', 'instance'],
    dependencies: ['create_concept_instance'],
    addedDate: '2026-03-10',
};

export const addInstanceHandler = async (params: {
    targetClass: string;
    instanceName: string;
    properties: Record<string, unknown>;
    ontology?: string;
    contextUri?: string;
}) => {
    await ensureShapeCache();

    const shape = findShapeByTargetClass(params.targetClass);
    if (!shape) {
        return {
            isError: true,
            content: [{ type: 'text' as const, text: `No SHACL shape found for ${params.targetClass}.` }],
        };
    }

    const validationErrors = [
        ...validateRequiredAndKnownProperties(shape, params.properties),
        ...shape.properties.flatMap((prop: PropertyConstraint) => {
            const value = params.properties[prop.path];
            if (value === undefined || value === null) {
                return [];
            }
            return validatePropertyValue(prop, value);
        }),
    ];

    if (validationErrors.length > 0) {
        return {
            isError: true,
            content: [{ type: 'text' as const, text: `SHACL validation failed:\n- ${validationErrors.join('\n- ')}` }],
        };
    }

    const propertyValues = shape.properties
        .filter((prop: PropertyConstraint) => params.properties[prop.path] !== undefined && params.properties[prop.path] !== null)
        .map((prop: PropertyConstraint) => toPropertyValueParam(prop, params.properties[prop.path]));

    const ontology = resolveOntologyPath(params.ontology, params.contextUri || shape.contextUri);

    return createConceptInstanceHandler({
        ontology,
        name: params.instanceName,
        types: [shape.targetClass],
        propertyValues,
    });
};
