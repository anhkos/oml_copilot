import { z } from 'zod';
import type { PropertyConstraint } from '../../shacl/types.js';
import { deletePropertyValueHandler } from '../instances/delete-property-value.js';
import { updatePropertyValueHandler } from '../instances/update-property-value.js';
import {
    ensureShapeCache,
    findShapeByTargetClass,
    resolveOntologyPath,
    toPropertyValueParam,
    validatePropertyValue,
} from './shape-shared.js';

export const updateInstanceWithShapeTool = {
    name: 'update_instance_with_shape' as const,
    description: 'Update instance values with SHACL-aware validation. Wrapper delegates writes to update_property_value/delete_property_value.',
    paramsSchema: {
        targetClass: z.string().describe('Target class used to resolve SHACL constraints.'),
        instanceName: z.string().describe('Name of instance to update.'),
        properties: z.record(z.any()).optional().describe('Property values to set/replace.'),
        clearProperties: z.array(z.string()).optional().describe('Property paths to remove from the instance.'),
        ontology: z.string().optional().describe('Absolute or workspace-relative description ontology path.'),
        contextUri: z.string().optional().describe('workspace:/... context URI for the target description model.'),
    },
};

export const updateInstanceWithShapeMetadata = {
    id: 'update_instance_with_shape',
    displayName: 'Update Instance (SHACL)',
    layer: 'description' as const,
    severity: 'high' as const,
    version: '1.0.0',
    shortDescription: 'Constraint-aware update wrapper',
    description: 'Validates against SHACL constraints before delegating to existing instance property mutation tools.',
    tags: ['shacl', 'update', 'instance'],
    dependencies: ['update_property_value', 'delete_property_value'],
    addedDate: '2026-03-10',
};

export const updateInstanceWithShapeHandler = async (params: {
    targetClass: string;
    instanceName: string;
    properties?: Record<string, unknown>;
    clearProperties?: string[];
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

    const ontology = resolveOntologyPath(params.ontology, params.contextUri || shape.contextUri);
    const nextProperties = params.properties || {};
    const clearProperties = params.clearProperties || [];
    const clearSet = new Set(clearProperties);

    const unknownInSet = [...Object.keys(nextProperties), ...clearProperties]
        .filter((key) => !shape.properties.some((p: PropertyConstraint) => p.path === key));
    if (unknownInSet.length > 0) {
        return {
            isError: true,
            content: [{ type: 'text' as const, text: `Unknown properties for ${shape.targetClass}: ${unknownInSet.join(', ')}` }],
        };
    }

    const requiredViolations = shape.properties
        .filter((prop: PropertyConstraint) => prop.minCount && prop.minCount > 0)
        .filter((prop: PropertyConstraint) => clearSet.has(prop.path))
        .map((prop: PropertyConstraint) => prop.message || `${prop.path} is required and cannot be cleared.`);
    if (requiredViolations.length > 0) {
        return {
            isError: true,
            content: [{ type: 'text' as const, text: `SHACL validation failed:\n- ${requiredViolations.join('\n- ')}` }],
        };
    }

    const valueErrors = shape.properties.flatMap((prop: PropertyConstraint) => {
        const value = nextProperties[prop.path];
        if (value === undefined || value === null) {
            return [];
        }
        return validatePropertyValue(prop, value);
    });
    if (valueErrors.length > 0) {
        return {
            isError: true,
            content: [{ type: 'text' as const, text: `SHACL validation failed:\n- ${valueErrors.join('\n- ')}` }],
        };
    }

    for (const property of clearProperties) {
        const result = await deletePropertyValueHandler({ ontology, instance: params.instanceName, property });
        if (result.isError) {
            return result;
        }
    }

    for (const prop of shape.properties) {
        const value = nextProperties[prop.path];
        if (value === undefined || value === null) {
            continue;
        }

        const mapped = toPropertyValueParam(prop, value);
        const result = await updatePropertyValueHandler({
            ontology,
            instanceName: params.instanceName,
            property: mapped.property,
            literalValues: mapped.literalValues,
            referencedValues: mapped.referencedValues,
        });

        if (result.isError) {
            return result;
        }
    }

    return {
        content: [{
            type: 'text' as const,
            text: `✓ Updated instance "${params.instanceName}" with SHACL-validated properties for ${shape.targetClass}.`,
        }],
    };
};
