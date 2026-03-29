import { parseAllShapes } from '../../shacl/parser.js';
import type { PropertyConstraint, ShapeDefinition } from '../../shacl/types.js';
import type { LiteralParam, PropertyValueParam } from '../common.js';
import { getWorkspaceRoot, resolveWorkspacePath } from '../common.js';

let shapeCache: ShapeDefinition[] = [];
let shapeCacheWorkspace = '';

export const SHACL_CRUD_TOOL_NAMES = [
    'add_instance',
    'update_instance_with_shape',
    'delete_instance_with_shape',
] as const;

export async function ensureShapeCache(): Promise<void> {
    const workspace = getWorkspaceRoot();
    if (shapeCache.length > 0 && shapeCacheWorkspace === workspace) {
        return;
    }

    shapeCache = await parseAllShapes(workspace);
    shapeCacheWorkspace = workspace;
}

export async function preloadShapeCatalog(): Promise<{
    workspace: string;
    shapeCount: number;
    targetClasses: string[];
}> {
    await ensureShapeCache();
    return {
        workspace: shapeCacheWorkspace,
        shapeCount: shapeCache.length,
        targetClasses: shapeCache.map((shape) => shape.targetClass).sort(),
    };
}

export function getShapeCache(): ShapeDefinition[] {
    return shapeCache;
}

export function resolveOntologyPath(ontology?: string, contextUri?: string): string {
    if (ontology && ontology.trim().length > 0) {
        return resolveWorkspacePath(ontology.trim());
    }

    if (contextUri && contextUri.trim().length > 0) {
        const cleaned = contextUri.trim().replace(/^workspace:/, '');
        return resolveWorkspacePath(cleaned);
    }

    throw new Error('Either ontology or contextUri must be provided.');
}

export function findShapeByTargetClass(targetClass: string): ShapeDefinition | undefined {
    return shapeCache.find((shape) => shape.targetClass === targetClass);
}

export function mapDatatypeToLiteralType(datatype?: string): LiteralParam['type'] {
    if (!datatype) return 'quoted';
    const normalized = datatype.toLowerCase();
    if (normalized.includes('integer') || normalized.endsWith(':int')) return 'integer';
    if (normalized.includes('decimal')) return 'decimal';
    if (normalized.includes('double') || normalized.includes('float')) return 'double';
    if (normalized.includes('boolean')) return 'boolean';
    return 'quoted';
}

export function generateQueryVariations(query: string): string[] {
    const q = query.toLowerCase().trim();
    const vars = new Set<string>([q]);

    if (q.endsWith('s') && q.length > 1) {
        vars.add(q.slice(0, -1));
    } else {
        vars.add(`${q}s`);
    }

    if (q.endsWith('ies')) {
        vars.add(`${q.slice(0, -3)}y`);
    }
    if (q.endsWith('y')) {
        vars.add(`${q.slice(0, -1)}ies`);
    }

    vars.add(q.replace(/-/g, ' '));
    vars.add(q.replace(/ /g, '-'));
    vars.add(q.replace(/[- ]/g, ''));

    return [...vars].filter(Boolean);
}

export function shapeMatchesQuery(shape: ShapeDefinition, query: string): boolean {
    const terms = generateQueryVariations(query);
    const className = (shape.targetClass.split(':')[1] || shape.targetClass).toLowerCase();
    const shapeName = shape.shapeUri.toLowerCase();
    const sourceFile = (shape.filePath || '').toLowerCase();
    const propText = shape.properties
        .map((p) => `${p.path} ${p.name || ''} ${p.class || ''} ${p.datatype || ''}`)
        .join(' ')
        .toLowerCase();

    return terms.some((t) => className.includes(t) || shapeName.includes(t) || sourceFile.includes(t) || propText.includes(t));
}

export function getRequiredProperties(shape: ShapeDefinition): PropertyConstraint[] {
    return shape.properties.filter((prop) => (prop.minCount ?? 0) > 0);
}

export function buildRequiredPropertyQuestions(shape: ShapeDefinition): string[] {
    const required = getRequiredProperties(shape);
    return required.map((prop) => {
        const label = prop.name || prop.path;
        const typeHint = prop.class
            ? `reference to ${prop.class}`
            : prop.datatype
                ? prop.datatype
                : 'value';
        return `What value should I use for required property ${label} (${prop.path}, ${typeHint})?`;
    });
}

export function buildShapeWorkflowHint(shape: ShapeDefinition): Record<string, unknown> {
    return {
        targetClass: shape.targetClass,
        instanceKind: 'instance',
        targetLocation: shape.contextUri || shape.filePath || null,
        requiredProperties: getRequiredProperties(shape).map((prop) => ({
            path: prop.path,
            name: prop.name,
            datatype: prop.datatype,
            class: prop.class,
            message: prop.message,
        })),
        followUpQuestions: buildRequiredPropertyQuestions(shape),
        nextToolCall: {
            tool: 'add_instance',
            argsTemplate: {
                targetClass: shape.targetClass,
                instanceName: '<ask-user-or-generate>',
                contextUri: shape.contextUri,
                properties: '<collect-required-and-optional-values>',
            },
        },
    };
}

export function validateRequiredAndKnownProperties(
    shape: ShapeDefinition,
    properties: Record<string, unknown>,
): string[] {
    const errors: string[] = [];
    const allowed = new Set(shape.properties.map((p) => p.path));

    for (const key of Object.keys(properties)) {
        if (!allowed.has(key)) {
            errors.push(`Property "${key}" is not defined by shape ${shape.shapeUri}.`);
        }
    }

    for (const prop of shape.properties) {
        if (!prop.minCount || prop.minCount < 1) continue;
        const value = properties[prop.path];
        if (value === undefined || value === null || value === '') {
            errors.push(prop.message || `${prop.path} is required.`);
        }
    }

    return errors;
}

export function validatePropertyValue(prop: PropertyConstraint, value: unknown): string[] {
    const errors: string[] = [];
    const values = Array.isArray(value) ? value : [value];

    if (prop.maxCount === 1 && values.length > 1) {
        errors.push(`${prop.path} allows max 1 value.`);
    }

    if (prop.class) {
        for (const item of values) {
            if (typeof item !== 'string') {
                errors.push(`${prop.path} expects reference names (strings) for class ${prop.class}.`);
            }
        }
        return errors;
    }

    if (prop.datatype) {
        const type = mapDatatypeToLiteralType(prop.datatype);
        for (const item of values) {
            if (type === 'integer' && !Number.isInteger(item)) {
                errors.push(`${prop.path} expects integer values.`);
            }
            if ((type === 'decimal' || type === 'double') && typeof item !== 'number') {
                errors.push(`${prop.path} expects numeric values.`);
            }
            if (type === 'boolean' && typeof item !== 'boolean') {
                errors.push(`${prop.path} expects boolean values.`);
            }
            if (type === 'quoted' && typeof item !== 'string') {
                errors.push(`${prop.path} expects string values.`);
            }
        }
    }

    return errors;
}

export function toPropertyValueParam(prop: PropertyConstraint, value: unknown): PropertyValueParam {
    const values = Array.isArray(value) ? value : [value];

    if (prop.class) {
        return {
            property: prop.path,
            referencedValues: values.map((v) => String(v)),
        };
    }

    const litType = mapDatatypeToLiteralType(prop.datatype);
    return {
        property: prop.path,
        literalValues: values.map((v) => ({
            type: litType,
            value: v as string | number | boolean,
        })),
    };
}
