import type { ToolRegistration } from '../types.js';
import {
    addInstanceTool,
    addInstanceHandler,
    addInstanceMetadata,
} from './shape-create.js';
import {
    updateInstanceWithShapeTool,
    updateInstanceWithShapeHandler,
    updateInstanceWithShapeMetadata,
} from './shape-update.js';
import {
    deleteInstanceWithShapeTool,
    deleteInstanceWithShapeHandler,
    deleteInstanceWithShapeMetadata,
} from './shape-delete.js';

export const crudCreateTools: ToolRegistration[] = [
    { tool: addInstanceTool, handler: addInstanceHandler, metadata: addInstanceMetadata },
];

export const crudUpdateTools: ToolRegistration[] = [
    { tool: updateInstanceWithShapeTool, handler: updateInstanceWithShapeHandler, metadata: updateInstanceWithShapeMetadata },
];

export const crudDeleteTools: ToolRegistration[] = [
    { tool: deleteInstanceWithShapeTool, handler: deleteInstanceWithShapeHandler, metadata: deleteInstanceWithShapeMetadata },
];

export const crudToolBuckets = {
    create: crudCreateTools,
    update: crudUpdateTools,
    delete: crudDeleteTools,
} as const;

export const crudTools: ToolRegistration[] = [
    ...crudCreateTools,
    ...crudUpdateTools,
    ...crudDeleteTools,
];
