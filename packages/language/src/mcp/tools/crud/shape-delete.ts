import { z } from 'zod';
import { deleteInstanceHandler } from '../instances/delete-instance.js';
import { resolveOntologyPath } from './shape-shared.js';

export const deleteInstanceWithShapeTool = {
    name: 'delete_instance_with_shape' as const,
    description: 'Delete an instance using the existing delete_instance handler (impact analysis included).',
    paramsSchema: {
        instanceName: z.string().describe('Name of instance to delete.'),
        ontology: z.string().optional().describe('Absolute or workspace-relative description ontology path.'),
        contextUri: z.string().optional().describe('workspace:/... context URI for the target description model.'),
        force: z.boolean().optional().describe('Force deletion despite reference warnings.'),
    },
};

export const deleteInstanceWithShapeMetadata = {
    id: 'delete_instance_with_shape',
    displayName: 'Delete Instance (SHACL)',
    layer: 'description' as const,
    severity: 'high' as const,
    version: '1.0.0',
    shortDescription: 'Generic delete wrapper',
    description: 'Generic CRUD delete entrypoint that delegates to delete_instance and keeps impact analysis behavior.',
    tags: ['shacl', 'delete', 'instance'],
    dependencies: ['delete_instance'],
    addedDate: '2026-03-10',
};

export const deleteInstanceWithShapeHandler = async (params: {
    instanceName: string;
    ontology?: string;
    contextUri?: string;
    force?: boolean;
}) => {
    const ontology = resolveOntologyPath(params.ontology, params.contextUri);
    return deleteInstanceHandler({ ontology, instance: params.instanceName, force: params.force });
};
