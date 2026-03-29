import { Parser, type Quad } from 'n3';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
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
    name: 'http://www.w3.org/ns/shacl#name',
    message: 'http://www.w3.org/ns/shacl#message',
    editor: 'http://datashapes.org/dash#editor',
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
        return this.parseShapeContent(content);
    }

    parseShapeContent(content: string): ShapeDefinition[] {
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
                case SHACL.name:
                    constraint.name = obj;
                    break;
                case SHACL.message:
                    constraint.message = obj;
                    break;
                case SHACL.editor:
                    constraint.editor = this.compactUri(obj);
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
    const allShapes: ShapeDefinition[] = [];
    const seenTargetClasses = new Map<string, string>(); // targetClass → shapeUri for dedup

    const shapeFiles = discoverShapeSources(workspacePath);
    const cachePath = path.join(workspacePath, '.oml-cache', 'shacl-shapes-cache.json');

    if (shapeFiles.length === 0) {
        console.error('[shacl-parser] No SHACL source files found (.ttl or markdown table-editor blocks)');
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

    const ttlFiles = shapeFiles.filter(file => file.endsWith('.ttl'));
    const markdownFiles = shapeFiles.filter(file => file.endsWith('.md'));

    const ttlParser = new SHACLParser();
    for (const file of ttlFiles) {
        try {
            const shapes = await ttlParser.parseShapeFile(file);
            ingestShapes(allShapes, seenTargetClasses, shapes.map(shape => ({ ...shape, filePath: file })));
            if (shapes.length > 0) {
                console.error(`[shacl-parser] Parsed ${shapes.length} shapes from ${file}`);
            }
        } catch (error) {
            console.error(`[shacl-parser] Failed to parse ${file}:`, error);
        }
    }

    const markdownParser = new MarkdownShapeParser();
    for (const file of markdownFiles) {
        try {
            const shapes = await markdownParser.parseMarkdownFile(file);
            ingestShapes(allShapes, seenTargetClasses, shapes);
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

function ingestShapes(allShapes: ShapeDefinition[], seenTargetClasses: Map<string, string>, shapes: ShapeDefinition[]): void {
    for (const shape of shapes) {
        const existing = seenTargetClasses.get(shape.targetClass);
        if (existing) {
            console.error(
                `[shacl-parser] Warning: duplicate target class ${shape.targetClass} from ${shape.shapeUri} (already defined by ${existing}), skipping`,
            );
            continue;
        }
        seenTargetClasses.set(shape.targetClass, shape.shapeUri);
        allShapes.push(shape);
    }
}

function discoverShapeSources(workspacePath: string): string[] {
    const files: string[] = [];
    const markdownRoots = discoverMarkdownRoots(workspacePath);

    const shapesDir = path.join(workspacePath, 'shapes');
    if (fs.existsSync(shapesDir)) {
        files.push(...findFilesByExtension(shapesDir, '.ttl'));
        files.push(...findFilesByExtension(shapesDir, '.md').filter(fileHasTableEditorBlock));
    }

    const docsDir = path.join(workspacePath, 'packages');
    if (fs.existsSync(docsDir)) {
        files.push(...findFilesByExtension(docsDir, '.md').filter(fileHasTableEditorBlock));
    }

    if (markdownRoots.length > 0) {
        console.error(`[shacl-parser] Markdown shape roots: ${markdownRoots.join(', ')}`);
    }

    for (const mdRoot of markdownRoots) {
        files.push(...findFilesByExtension(mdRoot, '.md').filter(fileHasTableEditorBlock));
    }

    return Array.from(new Set(files)).sort();
}

function discoverMarkdownRoots(workspacePath: string): string[] {
    const roots = new Set<string>();

    // Local workspace conventions.
    const localCandidates = [
        path.join(workspacePath, 'src', 'md'),
        path.join(workspacePath, 'src', 'model', 'md'),
        path.join(workspacePath, 'md'),
        path.join(process.cwd(), 'src', 'md'),
        path.join(process.cwd(), 'src', 'model', 'md'),
    ];
    for (const candidate of localCandidates) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
            roots.add(path.normalize(candidate));
        }
    }

    // Explicit override (semicolon-delimited on Windows, colon on Unix).
    const envRoots = (process.env.OML_SHAPE_MD_ROOTS || '')
        .split(path.delimiter)
        .map(item => item.trim())
        .filter(Boolean);
    for (const envRoot of envRoots) {
        if (fs.existsSync(envRoot) && fs.statSync(envRoot).isDirectory()) {
            roots.add(path.normalize(envRoot));
        }
    }

    // Common dev layouts with sibling repositories.
    const githubBases = [
        path.join(os.homedir(), 'OneDrive', 'Documents', 'GitHub'),
        path.join(os.homedir(), 'Documents', 'GitHub'),
    ];

    for (const base of githubBases) {
        if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) {
            continue;
        }

        const directCandidates = [
            path.join(base, 'src', 'md'),
            path.join(base, 'src', 'model', 'md'),
        ];
        for (const directMd of directCandidates) {
            if (fs.existsSync(directMd) && fs.statSync(directMd).isDirectory()) {
                roots.add(path.normalize(directMd));
            }
        }

        let entries: fs.Dirent[] = [];
        try {
            entries = fs.readdirSync(base, { withFileTypes: true });
        } catch {
            entries = [];
        }

        for (const entry of entries) {
            if (!entry.isDirectory()) {
                continue;
            }
            const repoCandidates = [
                path.join(base, entry.name, 'src', 'md'),
                path.join(base, entry.name, 'src', 'model', 'md'),
            ];
            for (const repoMd of repoCandidates) {
                if (fs.existsSync(repoMd) && fs.statSync(repoMd).isDirectory()) {
                    roots.add(path.normalize(repoMd));
                }
            }
        }
    }

    return [...roots];
}

function fileHasTableEditorBlock(filePath: string): boolean {
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        return /```table-editor/i.test(content);
    } catch {
        return false;
    }
}

class MarkdownShapeParser {
    private parser = new SHACLParser();

    async parseMarkdownFile(filePath: string): Promise<ShapeDefinition[]> {
        const content = fs.readFileSync(filePath, 'utf-8');
        const contextUri = extractContextUri(content);
        const blocks = extractTableEditorBlocks(content);

        if (blocks.length === 0) {
            return [];
        }

        const shapes: ShapeDefinition[] = [];
        for (const block of blocks) {
            try {
                const parsed = this.parser.parseShapeContent(block);
                for (const shape of parsed) {
                    shapes.push({
                        ...shape,
                        filePath,
                        contextUri,
                    });
                }
            } catch (error) {
                console.error(`[shacl-parser] Failed to parse table-editor block in ${filePath}:`, error);
            }
        }

        return shapes;
    }
}

function extractContextUri(markdown: string): string | undefined {
    const frontmatterMatch = markdown.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!frontmatterMatch) {
        return undefined;
    }

    const contextMatch = frontmatterMatch[1].match(/^contextUri:\s*(.+)$/m);
    if (!contextMatch) {
        return undefined;
    }

    return contextMatch[1].trim().replace(/^['"]|['"]$/g, '');
}

function extractTableEditorBlocks(markdown: string): string[] {
    const blocks: string[] = [];
    const regex = /```table-editor\s*\n([\s\S]*?)```/gi;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(markdown)) !== null) {
        const block = stripEmbeddedFrontmatter(match[1]).trim();
        if (block.length > 0) {
            blocks.push(block);
        }
    }

    return blocks;
}

function stripEmbeddedFrontmatter(block: string): string {
    const trimmed = block.trimStart();
    if (!trimmed.startsWith('---')) {
        return block;
    }

    const lines = trimmed.split(/\r?\n/);
    if (lines.length < 3 || lines[0].trim() !== '---') {
        return block;
    }

    let endIndex = -1;
    for (let i = 1; i < lines.length; i += 1) {
        if (lines[i].trim() === '---') {
            endIndex = i;
            break;
        }
    }

    if (endIndex === -1) {
        return block;
    }

    return lines.slice(endIndex + 1).join('\n');
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
function findFilesByExtension(dir: string, extension: string): string[] {
    let items: fs.Dirent[];
    try {
        items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return [];
    }

    const results: string[] = [];
    for (const item of items) {
        if (item.isDirectory()) {
            results.push(...findFilesByExtension(path.join(dir, item.name), extension));
        } else if (item.isFile() && item.name.endsWith(extension)) {
            results.push(path.join(dir, item.name));
        }
    }
    return results;
}
