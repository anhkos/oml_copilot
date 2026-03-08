import { Parser, type Quad } from 'n3';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import type { PropertyConstraint, ShapeDefinition } from './types.js';

const SHACL = {
    NodeShape: 'http://www.w3.org/ns/shacl#NodeShape',
    targetClass: 'http://www.w3.org/ns/shacl#targetClass',
    property: 'http://www.w3.org/ns/shacl#property',
    path: 'http://www.w3.org/ns/shacl#path',
    minCount: 'http://www.w3.org/ns/shacl#minCount',
    maxCount: 'http://www.w3.org/ns/shacl#maxCount',
    datatype: 'http://www.w3.org/ns/shacl#datatype',
    class: 'http://www.w3.org/ns/shacl#class',
    message: 'http://www.w3.org/ns/shacl#message',
};

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const CACHE_VERSION = 1;

interface SHACLShapeCache {
    version: number;
    fingerprint: string;
    shapes: ShapeDefinition[];
    generatedAt: string;
}

export class SHACLParser {
    private namespaces: Map<string, string> = new Map();

    async parseShapeFile(filePath: string): Promise<ShapeDefinition[]> {
        const content = fs.readFileSync(filePath, 'utf-8');
        const parser = new Parser();
        const quads: Quad[] = parser.parse(content);

        this.extractNamespaces(content);

        const shapeUris = this.findNodeShapes(quads);
        const shapes: ShapeDefinition[] = [];

        for (const shapeUri of shapeUris) {
            const shape = this.parseShape(shapeUri, quads);
            if (shape) {
                shapes.push(shape);
            }
        }

        return shapes;
    }

    private extractNamespaces(content: string): void {
        this.namespaces.clear();
        const prefixRegex = /@prefix\s+(\w+):\s+<([^>]+)>/g;
        let match;
        while ((match = prefixRegex.exec(content)) !== null) {
            this.namespaces.set(match[1], match[2]);
        }
    }

    private findNodeShapes(quads: Quad[]): string[] {
        const shapeUris: string[] = [];
        for (const quad of quads) {
            if (
                quad.predicate.value === RDF_TYPE &&
                quad.object.value === SHACL.NodeShape
            ) {
                shapeUris.push(quad.subject.value);
            }
        }
        return shapeUris;
    }

    private parseShape(shapeUri: string, quads: Quad[]): ShapeDefinition | null {
        let targetClass: string | null = null;
        for (const quad of quads) {
            if (
                quad.subject.value === shapeUri &&
                quad.predicate.value === SHACL.targetClass
            ) {
                targetClass = quad.object.value;
                break;
            }
        }

        if (!targetClass) {
            console.error(`[shacl-parser] Shape ${shapeUri} has no sh:targetClass, skipping`);
            return null;
        }

        const propertyNodes: string[] = [];
        for (const quad of quads) {
            if (
                quad.subject.value === shapeUri &&
                quad.predicate.value === SHACL.property
            ) {
                propertyNodes.push(quad.object.value);
            }
        }

        const properties: PropertyConstraint[] = [];
        for (const propNode of propertyNodes) {
            const constraint = this.parsePropertyConstraint(propNode, quads);
            if (constraint) {
                properties.push(constraint);
            }
        }

        return {
            shapeUri: this.compactUri(shapeUri),
            targetClass: this.compactUri(targetClass),
            properties,
        };
    }

    private parsePropertyConstraint(propNode: string, quads: Quad[]): PropertyConstraint | null {
        const constraint: Partial<PropertyConstraint> = {};

        for (const quad of quads) {
            if (quad.subject.value !== propNode) continue;

            const pred = quad.predicate.value;
            const obj = quad.object.value;

            switch (pred) {
                case SHACL.path:
                    constraint.path = this.compactUri(obj);
                    break;
                case SHACL.minCount:
                    constraint.minCount = parseInt(obj, 10);
                    break;
                case SHACL.maxCount:
                    constraint.maxCount = parseInt(obj, 10);
                    break;
                case SHACL.datatype:
                    constraint.datatype = this.compactUri(obj);
                    break;
                case SHACL.class:
                    constraint.class = this.compactUri(obj);
                    break;
                case SHACL.message:
                    constraint.message = obj;
                    break;
            }
        }

        if (!constraint.path) {
            console.error(`[shacl-parser] Property constraint missing sh:path, skipping`);
            return null;
        }

        return constraint as PropertyConstraint;
    }

    private compactUri(uri: string): string {
        for (const [prefix, namespace] of this.namespaces.entries()) {
            if (uri.startsWith(namespace)) {
                return `${prefix}:${uri.substring(namespace.length)}`;
            }
        }
        return uri;
    }
}

/**
 * Parse all SHACL shape files from the `shapes/` directory at the workspace root.
 * All .ttl files under that directory are treated as SHACL shape files.
 */
export async function parseAllShapes(workspacePath: string): Promise<ShapeDefinition[]> {
    const parser = new SHACLParser();
    const allShapes: ShapeDefinition[] = [];
    const seenTargetClasses = new Map<string, string>(); // targetClass → shapeUri for dedup

    const shapesDir = path.join(workspacePath, 'shapes');
    if (!fs.existsSync(shapesDir)) {
        console.error(`[shacl-parser] No shapes/ directory found at workspace root (${shapesDir})`);
        return allShapes;
    }

    const shapeFiles = findTtlFiles(shapesDir).sort();
    const cachePath = path.join(workspacePath, '.oml-cache', 'shacl-shapes-cache.json');

    if (shapeFiles.length === 0) {
        console.error(`[shacl-parser] No .ttl shape files found under ${shapesDir}`);
        return allShapes;
    }

    const cacheDisabled = process.env.OML_SHACL_CACHE === 'off';
    const fingerprint = computeShapeFingerprint(shapeFiles);

    if (!cacheDisabled) {
        const cachedShapes = tryReadCachedShapes(cachePath, fingerprint);
        if (cachedShapes) {
            console.error(`[shacl-parser] Cache hit (${cachedShapes.length} shapes)`);
            return cachedShapes;
        }
        console.error('[shacl-parser] Cache miss, reparsing shape files');
    } else {
        console.error('[shacl-parser] Cache disabled via OML_SHACL_CACHE=off');
    }

    for (const file of shapeFiles) {
        try {
            const shapes = await parser.parseShapeFile(file);
            for (const shape of shapes) {
                const existing = seenTargetClasses.get(shape.targetClass);
                if (existing) {
                    console.error(`[shacl-parser] Warning: duplicate target class ${shape.targetClass} from ${shape.shapeUri} (already defined by ${existing}), skipping`);
                    continue;
                }
                seenTargetClasses.set(shape.targetClass, shape.shapeUri);
                allShapes.push(shape);
            }
            if (shapes.length > 0) {
                console.error(`[shacl-parser] Parsed ${shapes.length} shapes from ${file}`);
            }
        } catch (error) {
            console.error(`[shacl-parser] Failed to parse ${file}:`, error);
        }
    }

    if (!cacheDisabled) {
        writeCachedShapes(cachePath, fingerprint, allShapes);
    }

    return allShapes;
}

function computeShapeFingerprint(shapeFiles: string[]): string {
    const hash = createHash('sha256');
    hash.update(String(CACHE_VERSION));

    for (const file of shapeFiles) {
        try {
            const stat = fs.statSync(file);
            hash.update(file);
            hash.update(String(stat.mtimeMs));
            hash.update(String(stat.size));
        } catch {
            hash.update(file);
            hash.update('missing');
        }
    }

    return hash.digest('hex');
}

function tryReadCachedShapes(cachePath: string, fingerprint: string): ShapeDefinition[] | undefined {
    if (!fs.existsSync(cachePath)) {
        return undefined;
    }

    try {
        const raw = fs.readFileSync(cachePath, 'utf-8');
        const parsed = JSON.parse(raw) as SHACLShapeCache;
        if (
            parsed.version !== CACHE_VERSION ||
            parsed.fingerprint !== fingerprint ||
            !Array.isArray(parsed.shapes)
        ) {
            return undefined;
        }
        return parsed.shapes;
    } catch {
        return undefined;
    }
}

function writeCachedShapes(cachePath: string, fingerprint: string, shapes: ShapeDefinition[]): void {
    try {
        fs.mkdirSync(path.dirname(cachePath), { recursive: true });
        const payload: SHACLShapeCache = {
            version: CACHE_VERSION,
            fingerprint,
            shapes,
            generatedAt: new Date().toISOString(),
        };
        fs.writeFileSync(cachePath, JSON.stringify(payload, null, 2), 'utf-8');
    } catch (error) {
        console.error('[shacl-parser] Failed to write SHACL cache:', error);
    }
}

/**
 * Find all .ttl files under a directory (recursive).
 */
function findTtlFiles(dir: string): string[] {
    let items: fs.Dirent[];
    try {
        items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return [];
    }

    const results: string[] = [];
    for (const item of items) {
        if (item.isDirectory()) {
            results.push(...findTtlFiles(path.join(dir, item.name)));
        } else if (item.isFile() && item.name.endsWith('.ttl')) {
            results.push(path.join(dir, item.name));
        }
    }
    return results;
}
