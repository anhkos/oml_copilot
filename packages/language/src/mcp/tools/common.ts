import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node.js';
import {
    getOmlServices,
    getFreshDocument as getFreshDocumentFromStore,
    invalidateDocument,
    getWorkspaceRoot as getWorkspaceRootFromResolver,
    resolveWorkspacePath as resolveWorkspacePathFromResolver,
    pathToFileUri as pathToFileUriFromResolver,
    fileUriToPath as fileUriToPathFromResolver,
    detectIndentation as detectIndentationFromResolver,
} from '../services/index.js';
import {
    AnnotationProperty,
    Aspect,
    Concept,
    Description,
    RelationEntity,
    Scalar,
    ScalarProperty,
    UnreifiedRelation,
    Vocabulary,
    isDescription,
    isVocabulary,
    isAnnotationProperty,
    isAspect,
    isConcept,
    isRelationEntity,
    isScalar,
    isScalarProperty,
    isUnreifiedRelation
} from '../../generated/ast.js';

export const LSP_BRIDGE_PORT = 5007;

/**
 * Get the workspace root directory.
 * Priority:
 * 1. OML_WORKSPACE_ROOT environment variable (set by VS Code MCP integration)
 * 2. Current working directory as fallback
 * 
 * Note: This is a re-export from services layer for backwards compatibility.
 */
export const getWorkspaceRoot = getWorkspaceRootFromResolver;

/**
 * Resolve a file path relative to the workspace root.
 * - If the path is already absolute, return it as-is.
 * - If relative, resolve against the workspace root (not cwd).
 * 
 * Note: This is a re-export from services layer for backwards compatibility.
 */
export const resolveWorkspacePath = resolveWorkspacePathFromResolver;

// OML reserved keywords that cannot be used as prefixes without escaping
export const OML_RESERVED_KEYWORDS = new Set([
    'all', 'annotation', 'as', 'aspect', 'asymmetric', 'builtin', 'bundle',
    'concept', 'description', 'differentFrom', 'domain', 'entity', 'exactly',
    'extends', 'forward', 'from', 'functional', 'includes', 'instance',
    'inverse', 'irreflexive', 'key', 'language', 'length', 'max', 'maxExclusive',
    'maxInclusive', 'maxLength', 'min', 'minExclusive', 'minInclusive', 'minLength',
    'oneOf', 'pattern', 'property', 'range', 'ref', 'reflexive', 'relation',
    'restricts', 'reverse', 'rule', 'sameAs', 'scalar', 'self', 'some',
    'symmetric', 'to', 'transitive', 'uses', 'vocabulary'
]);

/**
 * Escapes a prefix if it's a reserved OML keyword.
 * Returns the prefix with ^ prefix if it's a keyword, otherwise returns as-is.
 */
export function escapePrefix(prefix: string): string {
    // If already escaped, return as-is
    if (prefix.startsWith('^')) {
        return prefix;
    }
    // If it's a reserved keyword, escape it
    if (OML_RESERVED_KEYWORDS.has(prefix.toLowerCase())) {
        return `^${prefix}`;
    }
    return prefix;
}

/**
 * Strips the local vocabulary prefix from qualified names.
 * This prevents self-referential qualified names that confuse the import system.
 * 
 * E.g., if localPrefix is "capability" and name is "capability:Capability", returns "Capability".
 * Handles both escaped (^prefix) and unescaped prefixes.
 * 
 * @param name The potentially qualified name (e.g., "capability:Capability" or "Capability")
 * @param localPrefix The local vocabulary prefix (e.g., "capability" or "^capability")
 * @returns The name with local prefix stripped if present, otherwise the original name
 */
export function stripLocalPrefix(name: string, localPrefix: string): string {
    // Handle both escaped (^prefix) and unescaped prefixes
    const unescapedLocal = localPrefix.startsWith('^') ? localPrefix.slice(1) : localPrefix;
    const prefixWithColon = `${unescapedLocal}:`;
    const escapedPrefixWithColon = `^${unescapedLocal}:`;
    
    if (name.startsWith(prefixWithColon)) {
        return name.slice(prefixWithColon.length);
    }
    if (name.startsWith(escapedPrefixWithColon)) {
        return name.slice(escapedPrefixWithColon.length);
    }
    return name;
}

/**
 * Checks if a qualified name uses the local vocabulary's prefix.
 * 
 * @param name The potentially qualified name (e.g., "capability:Capability")
 * @param localPrefix The local vocabulary prefix (e.g., "capability")
 * @returns True if the name uses the local prefix
 */
export function isLocalReference(name: string, localPrefix: string): boolean {
    if (!name.includes(':')) return false;
    
    const prefix = name.split(':')[0];
    const unescapedLocal = localPrefix.startsWith('^') ? localPrefix.slice(1) : localPrefix;
    const unescapedPrefix = prefix.startsWith('^') ? prefix.slice(1) : prefix;
    
    return unescapedPrefix === unescapedLocal;
}

export type LiteralParam = {
    type: 'integer' | 'decimal' | 'double' | 'boolean' | 'quoted';
    value: string | number | boolean;
    scalarType?: string;
    langTag?: string;
};

export type AnnotationParam = {
    property: string;
    literalValues?: LiteralParam[];
    referencedValues?: string[];
};

export type PropertyValueParam = {
    property: string;
    literalValues?: LiteralParam[];
    referencedValues?: string[];
};

export type AnyTerm =
    | Scalar
    | Aspect
    | Concept
    | RelationEntity
    | ScalarProperty
    | AnnotationProperty
    | UnreifiedRelation;

/**
 * Custom error class for when a required ontology file does not exist.
 * Includes actionable guidance for the model to create the ontology first.
 */
export class OntologyNotFoundError extends Error {
    constructor(
        public readonly filePath: string,
        public readonly expectedKind: 'vocabulary' | 'description' | 'vocabulary or description'
    ) {
        const kindHint =
            expectedKind === 'vocabulary or description'
                ? 'vocabulary or description'
                : expectedKind;
        super(
            `ONTOLOGY NOT FOUND: ${filePath}\n\n` +
            `The target ${kindHint} file does not exist yet.\n\n` +
            `Create it first using create_ontology, then retry your operation.\n` +
            `Example:\n` +
            `  create_ontology(filePath=\"${filePath}\", kind=\"${expectedKind === 'vocabulary or description' ? 'vocabulary' : expectedKind}\", namespace=\"...\", prefix=\"...\")`
        );
        this.name = 'OntologyNotFoundError';
    }
}

/**
 * Custom error class for when a file exists but is not the expected ontology type.
 */
export class WrongOntologyTypeError extends Error {
    constructor(
        public readonly filePath: string,
        public readonly expectedKind: 'vocabulary' | 'description' | 'vocabulary or description',
        public readonly actualType: string
    ) {
        const expectedText = expectedKind === 'vocabulary or description'
            ? 'a vocabulary or description'
            : `a ${expectedKind}`;

        const actionHint = expectedKind === 'vocabulary'
            ? 'Terms (concepts, aspects, relations, properties, scalars) can only be created in vocabulary files. If you intended to create instances, use description tools like create_concept_instance.'
            : expectedKind === 'description'
                ? 'Instances can only be created in description files.'
                : 'Use a valid ontology file (vocabulary or description).';

        super(
            `WRONG ONTOLOGY TYPE: ${filePath}\n\n` +
            `Expected ${expectedText}, but found \"${actualType}\".\n\n` +
            `${actionHint}`
        );
        this.name = 'WrongOntologyTypeError';
    }
}

export function pathToFileUri(filePath: string): string {
    if (filePath.startsWith('file://')) {
        return filePath;
    }
    return pathToFileUriFromResolver(filePath);
}

export const fileUriToPath = fileUriToPathFromResolver;

/**
 * Gets a fresh document from disk, invalidating any cached version.
 * This ensures the MCP tools always work with the current file content,
 * not stale cached content that may have been modified externally.
 * 
 * Note: Now delegates to centralized document store from services layer.
 */
export async function getFreshDocument(services: ReturnType<typeof getOmlServices>, fileUri: string) {
    return getFreshDocumentFromStore(fileUri);
}

export async function loadVocabularyDocument(ontology: string) {
    const fileUri = pathToFileUri(ontology);
    const filePath = fileUriToPath(fileUri);

    if (!fs.existsSync(filePath)) {
        throw new OntologyNotFoundError(filePath, 'vocabulary');
    }

    const services = getOmlServices();
    
    // Use getFreshDocument to ensure we always read from disk
    const document = await getFreshDocument(services, fileUri);

    const root = document.parseResult?.value;
    
    // Debug: log parse errors if any
    if (document.parseResult?.lexerErrors && document.parseResult.lexerErrors.length > 0) {
        console.error(`[DEBUG] Vocabulary Lexer errors: ${document.parseResult.lexerErrors.map((e: any) => e.message).join(', ')}`);
    }
    if (document.parseResult?.parserErrors && document.parseResult.parserErrors.length > 0) {
        console.error(`[DEBUG] Vocabulary Parser errors: ${document.parseResult.parserErrors.map((e: any) => e.message).join(', ')}`);
    }
    
    if (!root || !isVocabulary(root)) {
        console.error(`[DEBUG] Vocabulary load failed: root=$type=${root?.$type}, isVocab=${root ? isVocabulary(root) : false}`);
        const actualType = root?.$type || 'unknown (parse failed)';
        throw new WrongOntologyTypeError(filePath, 'vocabulary', actualType);
    }

    const text = fs.readFileSync(filePath, 'utf-8');
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const indent = detectIndentation(text);

    return { services, document, vocabulary: root, fileUri, filePath, text, eol, indent };
}

/**
 * Load any OML ontology document (vocabulary or description).
 * Returns information about the ontology type to help determine correct import syntax.
 */
export async function loadAnyOntologyDocument(ontology: string) {
    const fileUri = pathToFileUri(ontology);
    const filePath = fileUriToPath(fileUri);

    if (!fs.existsSync(filePath)) {
        throw new OntologyNotFoundError(filePath, 'vocabulary or description');
    }

    const services = getOmlServices();
    
    // Use getFreshDocument to ensure we always read from disk
    const document = await getFreshDocument(services, fileUri);

    console.error(`[DEBUG] AnyOntology parseResult exists: ${!!document.parseResult}, parseResult.value exists: ${!!document.parseResult?.value}`);
    
    const root = document.parseResult?.value;
    
    // Debug: log parse errors if any
    if (!document.parseResult) {
        console.error(`[DEBUG] AnyOntology: document.parseResult is null/undefined!`);
    }
    if (document.parseResult?.lexerErrors && document.parseResult.lexerErrors.length > 0) {
        console.error(`[DEBUG] AnyOntology Lexer errors: ${document.parseResult.lexerErrors.map((e: any) => e.message).join(', ')}`);
    }
    if (document.parseResult?.parserErrors && document.parseResult.parserErrors.length > 0) {
        console.error(`[DEBUG] AnyOntology Parser errors: ${document.parseResult.parserErrors.map((e: any) => e.message).join(', ')}`);
    }
    
    const isVocab = root ? isVocabulary(root) : false;
    const isDesc = root ? isDescription(root) : false;
    
    if (!root || (!isVocab && !isDesc)) {
        console.error(`[DEBUG] AnyOntology load failed: root=$type=${root?.$type}, isVocab=${isVocab}, isDesc=${isDesc}`);
        const actualType = root?.$type || 'unknown (parse failed)';
        throw new WrongOntologyTypeError(filePath, 'vocabulary or description', actualType);
    }

    const text = fs.readFileSync(filePath, 'utf-8');
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const indent = detectIndentation(text);
    
    // For descriptions, imports use "uses" keyword; for vocabularies, "extends"
    const importKeyword = isDesc ? 'uses' : 'extends';
    const ontologyType = isDesc ? 'description' : 'vocabulary';
    const prefix = (root as Vocabulary | Description).prefix;
    const namespace = (root as Vocabulary | Description).namespace;

    return { 
        services, 
        document, 
        root: root as Vocabulary | Description, 
        fileUri, 
        filePath, 
        text, 
        eol, 
        indent,
        isVocabulary: isVocab,
        isDescription: isDesc,
        importKeyword,
        ontologyType,
        prefix,
        namespace,
    };
}

/**
 * Detect indentation style used in a file.
 * Note: This is a re-export from services layer for backwards compatibility.
 */
export const detectIndentation = detectIndentationFromResolver;

export function formatLiteral(lit: LiteralParam): string {
    switch (lit.type) {
        case 'integer':
        case 'decimal':
        case 'double':
            return String(lit.value);
        case 'boolean':
            return lit.value ? 'true' : 'false';
        case 'quoted': {
            const value = String(lit.value).replace(/"/g, '\\"');
            if (lit.scalarType) return `"${value}"^^${lit.scalarType}`;
            if (lit.langTag) return `"${value}"$${lit.langTag}`;
            return `"${value}"`;
        }
        default:
            return String(lit.value);
    }
}

export function formatAnnotation(annotation: AnnotationParam, indent: string): string {
    const values: string[] = [];
    if (annotation.literalValues && annotation.literalValues.length > 0) {
        values.push(...annotation.literalValues.map(formatLiteral));
    }
    if (annotation.referencedValues && annotation.referencedValues.length > 0) {
        values.push(...annotation.referencedValues);
    }
    const suffix = values.length > 0 ? ' ' + values.join(', ') : '';
    return `${indent}@${annotation.property}${suffix}`;
}

export function formatAnnotations(annotations: AnnotationParam[] | undefined, indent: string, eol: string): string {
    if (!annotations || annotations.length === 0) return '';
    return annotations.map((a) => formatAnnotation(a, indent)).join(eol) + eol;
}

export function insertBeforeClosingBrace(content: string, insertion: string): string {
    const closingIndex = content.lastIndexOf('}');
    if (closingIndex === -1) {
        throw new Error('Could not find closing brace in ontology file.');
    }
    return content.slice(0, closingIndex) + insertion + content.slice(closingIndex);
}

export function isTerm(node: unknown): node is AnyTerm {
    return (
        isScalar(node) ||
        isAspect(node) ||
        isConcept(node) ||
        isRelationEntity(node) ||
        isScalarProperty(node) ||
        isAnnotationProperty(node) ||
        isUnreifiedRelation(node)
    );
}

export function findTerm(vocabulary: Vocabulary, name: string): AnyTerm | undefined {
    return vocabulary.ownedStatements.find((stmt) => isTerm(stmt) && (stmt as AnyTerm).name === name) as AnyTerm | undefined;
}

export function collectImportPrefixes(text: string, localPrefix?: string): Set<string> {
    const prefixes = new Set<string>();
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
        const trimmed = line.trim();
        if (/^(extends|uses|includes)\b/.test(trimmed)) {
            const match = trimmed.match(/\bas\s+([^\s{]+)/);
            if (match) {
                prefixes.add(match[1]);
            }
        }
    }
    if (localPrefix) {
        prefixes.add(localPrefix);
    }
    return prefixes;
}

/**
 * Normalize the local part of a name to start with an uppercase letter. Preserves any prefix.
 * Examples: "probe" -> "Probe"; "base:probe" -> "base:Probe"; "Probe" stays the same.
 */
export function normalizeNameCase(name: string): { normalized: string; changed: boolean } {
    const hasPrefix = name.includes(':');
    const [prefix, local] = hasPrefix ? name.split(':', 2) : [undefined, name];

    if (!local || local.length === 0) {
        return { normalized: name, changed: false };
    }

    const fixedLocal = local[0].toUpperCase() + local.slice(1);
    const normalized = prefix ? `${prefix}:${fixedLocal}` : fixedLocal;
    return { normalized, changed: normalized !== name };
}

/**
 * Extract prefixes from an array of qualified names (e.g., ["base:Entity", "xsd:string"]).
 * Returns prefixes that are NOT in the existingPrefixes set.
 */
export function extractMissingPrefixes(names: string[], existingPrefixes: Set<string>): string[] {
    const referenced = new Set<string>();
    for (const name of names) {
        if (name.includes(':')) {
            const prefix = name.split(':')[0].replace(/^\^/, ''); // Handle escaped prefixes
            referenced.add(prefix);
        }
    }
    return [...referenced].filter((p) => !existingPrefixes.has(p) && !existingPrefixes.has(`^${p}`));
}

/**
 * Validate that all referenced prefixes in the given names are imported.
 * Returns an error result if any are missing, null otherwise.
 */
export function validateReferencedPrefixes(
    names: string[],
    existingPrefixes: Set<string>,
    context: string
): { isError: true; content: { type: 'text'; text: string }[] } | null {
    const missing = extractMissingPrefixes(names, existingPrefixes);
    if (missing.length > 0) {
        return {
            isError: true,
            content: [{
                type: 'text' as const,
                text: `Missing imports for prefixes: ${missing.join(', ')}. ${context} Run ensure_imports or add_import first, or use suggest_oml_symbols to find available terms.`
            }]
        };
    }
    return null;
}

export async function writeFileAndNotify(filePath: string, fileUri: string, newContent: string) {
    // Write with explicit sync to ensure content is flushed to disk
    const fd = fs.openSync(filePath, 'w');
    fs.writeSync(fd, newContent, 0, 'utf-8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);

    // Invalidate cached document immediately to avoid stale reads (especially on Windows mtime resolution)
    invalidateDocument(filePath);

    let socket: net.Socket | undefined;
    let connection: ReturnType<typeof createMessageConnection> | undefined;

    try {
        socket = net.connect({ port: LSP_BRIDGE_PORT });
        await new Promise<void>((resolve, reject) => {
            socket!.once('connect', () => resolve());
            socket!.once('error', (err) => reject(err));
            setTimeout(() => reject(new Error('Connection timeout')), 5000);
        });

        const reader = new StreamMessageReader(socket);
        const writer = new StreamMessageWriter(socket);
        connection = createMessageConnection(reader, writer);
        connection.listen();

        // Send didClose first to clear any cached state
        await connection.sendNotification('textDocument/didClose', {
            textDocument: { uri: fileUri },
        });

        // Then send didOpen with the new content
        await connection.sendNotification('textDocument/didOpen', {
            textDocument: {
                uri: fileUri,
                languageId: 'oml',
                version: Date.now(),
                text: newContent,
            },
        });
        
        console.error(`[mcp] LSP notified for ${fileUri}`);
    } catch (error) {
        console.error('[mcp] Failed to notify LSP bridge:', error);
    } finally {
        if (connection) connection.dispose();
        if (socket) socket.end();
    }
}

// Canonicalize scalar names and signal if the XSD import is required
const XSD_PREFIX = 'xsd';
const XSD_SCALAR_MAP: Record<string, string> = {
    string: 'xsd:string',
    integer: 'xsd:integer',
    int: 'xsd:int',
    decimal: 'xsd:decimal',
    double: 'xsd:double',
    boolean: 'xsd:boolean',
    gyear: 'xsd:gYear',
    gyearmonth: 'xsd:gYearMonth',
    date: 'xsd:date',
    datetime: 'xsd:dateTime',
};

export function canonicalizeScalarName(name: string): { normalized: string; needsXsdImport: boolean } {
    const trimmed = name.trim();
    const withoutCaret = trimmed.startsWith('^') ? trimmed.slice(1) : trimmed;
    const lower = withoutCaret.toLowerCase();

    // Bare name: map to xsd if known
    if (!lower.includes(':')) {
        const mapped = XSD_SCALAR_MAP[lower];
        if (mapped) return { normalized: mapped, needsXsdImport: true };
        return { normalized: lower, needsXsdImport: false };
    }

    // Prefixed form
    const [prefix, local] = lower.split(':', 2);
    const normalized = `${prefix}:${local}`;
    return { normalized, needsXsdImport: prefix === XSD_PREFIX };
}

// Backwards-compatible wrapper when only the normalized name is needed
export function normalizeScalarName(name: string): string {
    return canonicalizeScalarName(name).normalized;
}

/**
 * Tool result type for MCP handlers
 */
export type ToolResult = {
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
};

/**
 * Run validation on a file and return any errors found.
 * Returns null if validation succeeds, error messages otherwise.
 */
export async function runValidation(fileUri: string): Promise<string | null> {
    let socket: net.Socket | undefined;
    let connection: ReturnType<typeof createMessageConnection> | undefined;
    
    try {
        socket = net.connect({ port: LSP_BRIDGE_PORT });
        await new Promise<void>((resolve, reject) => {
            socket!.on('connect', () => resolve());
            socket!.on('error', (err) => reject(err));
            setTimeout(() => reject(new Error('Connection timeout')), 5000);
        });

        const reader = new StreamMessageReader(socket);
        const writer = new StreamMessageWriter(socket);
        connection = createMessageConnection(reader, writer);
        connection.listen();

        // Import dynamically to avoid circular dependencies
        const { DocumentDiagnosticRequest, DocumentDiagnosticReportKind } = await import('vscode-languageserver-protocol');
        
        const diagnosticsResponse = await connection.sendRequest(
            DocumentDiagnosticRequest.type.method,
            {
                textDocument: { uri: fileUri },
                previousResultId: undefined,
            }
        );

        connection.dispose();
        socket.end();

        const diagnostics = (diagnosticsResponse as any).kind === DocumentDiagnosticReportKind.Full 
            ? ((diagnosticsResponse as any).items || [])
            : [];

        // Filter for errors only (severity 1)
        const errors = diagnostics.filter((d: any) => d.severity === 1);
        
        if (errors.length === 0) {
            return null;
        }

        return errors.map((d: any) => {
            const line = (d.range?.start?.line ?? 0) + 1;
            const column = (d.range?.start?.character ?? 0) + 1;
            return `Line ${line}:${column} - ${d.message}`;
        }).join('\n');
        
    } catch (error) {
        // If LSP is unavailable, skip validation rather than fail
        console.error('[runValidation] LSP unavailable:', error);
        return null;
    } finally {
        if (connection) connection.dispose();
        if (socket) socket.end();
    }
}

/**
 * Append validation results to a successful tool result if safe mode is enabled.
 * This allows mutations to optionally run validation after completion.
 */
export async function appendValidationIfSafeMode(
    result: ToolResult,
    fileUri: string,
    safeMode: boolean
): Promise<ToolResult> {
    if (result.isError || !safeMode) {
        return result;
    }
    
    const validationErrors = await runValidation(fileUri);
    
    if (validationErrors) {
        return {
            content: [
                ...result.content,
                { type: 'text' as const, text: `\n⚠ Validation errors detected:\n${validationErrors}` }
            ],
            // Don't mark as error - the mutation succeeded, just validation found issues
        };
    }
    
    return {
        content: [
            ...result.content,
            { type: 'text' as const, text: '\n✓ Validation passed' }
        ]
    };
}

// ============================================================================
// IMPACT ANALYSIS UTILITIES
// ============================================================================

export interface ImpactReference {
    file: string;           // Relative path to the file
    line?: number;          // Line number if available
    context: string;        // The matching line/context
    type: 'specialization' | 'instance' | 'restriction' | 'relation' | 'property' | 'import' | 'reference';
}

export interface ImpactAnalysis {
    symbol: string;
    references: ImpactReference[];
    summary: string;
}

/**
 * Find all references to a symbol across the workspace.
 * This is used by delete tools to show impact before deletion.
 */
export async function findSymbolReferences(
    symbolName: string,
    currentFilePath: string,
    options: {
        searchSpecializations?: boolean;  // Look for ": symbolName" patterns
        searchInstances?: boolean;         // Look for instance type references
        searchPropertyUsage?: boolean;     // Look for property/relation usage
        searchImports?: boolean;           // Look for import references
    } = {}
): Promise<ImpactAnalysis> {
    const {
        searchSpecializations = true,
        searchInstances = true,
        searchPropertyUsage = true,
        searchImports = false,
    } = options;

    const references: ImpactReference[] = [];
    const workspaceRoot = getWorkspaceRoot();
    const currentFileNormalized = path.normalize(currentFilePath).toLowerCase();

    // Build regex patterns based on what we're looking for
    const patterns: { pattern: RegExp; type: ImpactReference['type'] }[] = [];
    
    // Escape the symbol name for regex
    const escaped = symbolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    
    if (searchSpecializations) {
        // Match ": symbolName" or ": prefix:symbolName" in specialization contexts
        patterns.push({
            pattern: new RegExp(`:\\s*(?:[\\w]+:)?${escaped}(?![\\w:])`, 'g'),
            type: 'specialization'
        });
    }
    
    if (searchInstances) {
        // Match "instance ... : symbolName" or type references
        patterns.push({
            pattern: new RegExp(`(?:instance|ci|ri)\\s+\\w+\\s*:\\s*(?:[\\w]+:)?${escaped}(?![\\w:])`, 'gi'),
            type: 'instance'
        });
    }
    
    if (searchPropertyUsage) {
        // Match property/relation references in restrictions, assertions, etc.
        patterns.push({
            pattern: new RegExp(`(?:restricts|domain|range|from|to)\\s+(?:all\\s+|some\\s+)?(?:[\\w]+:)?${escaped}(?![\\w:])`, 'gi'),
            type: 'restriction'
        });
        // Match property value assertions
        patterns.push({
            pattern: new RegExp(`^\\s*(?:[\\w]+:)?${escaped}\\s+`, 'gm'),
            type: 'property'
        });
    }
    
    if (searchImports) {
        patterns.push({
            pattern: new RegExp(`as\\s+\\^?${escaped}\\s*$`, 'gm'),
            type: 'import'
        });
    }
    
    // Always search for general references (the symbol appearing in code)
    patterns.push({
        pattern: new RegExp(`(?:[\\w]+:)?${escaped}(?![\\w:])`, 'g'),
        type: 'reference'
    });

    // Recursively search workspace for .oml files
    function searchDir(dir: string) {
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules' && entry.name !== 'build') {
                    searchDir(fullPath);
                } else if (entry.isFile() && entry.name.endsWith('.oml')) {
                    // Skip the current file
                    if (path.normalize(fullPath).toLowerCase() === currentFileNormalized) {
                        continue;
                    }
                    
                    try {
                        const content = fs.readFileSync(fullPath, 'utf-8');
                        const lines = content.split(/\r?\n/);
                        const relativePath = path.relative(workspaceRoot, fullPath).replace(/\\/g, '/');
                        
                        for (let i = 0; i < lines.length; i++) {
                            const line = lines[i];
                            for (const { pattern, type } of patterns) {
                                pattern.lastIndex = 0; // Reset regex state
                                if (pattern.test(line)) {
                                    // Avoid duplicate references for same line
                                    const existing = references.find(r => 
                                        r.file === relativePath && r.line === i + 1
                                    );
                                    if (!existing) {
                                        references.push({
                                            file: relativePath,
                                            line: i + 1,
                                            context: line.trim().substring(0, 80) + (line.trim().length > 80 ? '...' : ''),
                                            type
                                        });
                                    }
                                    break; // One match per line is enough
                                }
                            }
                        }
                    } catch {
                        // Skip unreadable files
                    }
                }
            }
        } catch {
            // Skip unreadable directories
        }
    }

    searchDir(workspaceRoot);

    // Generate summary
    const typeCounts: Record<string, number> = {};
    for (const ref of references) {
        typeCounts[ref.type] = (typeCounts[ref.type] || 0) + 1;
    }
    
    const parts: string[] = [];
    if (typeCounts.specialization) parts.push(`${typeCounts.specialization} specialization(s)`);
    if (typeCounts.instance) parts.push(`${typeCounts.instance} instance(s)`);
    if (typeCounts.restriction) parts.push(`${typeCounts.restriction} restriction(s)`);
    if (typeCounts.property) parts.push(`${typeCounts.property} property usage(s)`);
    if (typeCounts.import) parts.push(`${typeCounts.import} import(s)`);
    if (typeCounts.reference) parts.push(`${typeCounts.reference} reference(s)`);

    const summary = references.length === 0
        ? 'No external references found'
        : `Found ${references.length} reference(s) in ${new Set(references.map(r => r.file)).size} file(s): ${parts.join(', ')}`;

    return { symbol: symbolName, references, summary };
}

/**
 * Format impact analysis for display to user
 */
export function formatImpactWarning(impact: ImpactAnalysis, maxReferences: number = 10): string {
    if (impact.references.length === 0) {
        return '';
    }

    const lines: string[] = [
        `\n⚠️ IMPACT ANALYSIS for "${impact.symbol}":`,
        impact.summary,
        ''
    ];

    // Group by file
    const byFile = new Map<string, ImpactReference[]>();
    for (const ref of impact.references) {
        const existing = byFile.get(ref.file) || [];
        existing.push(ref);
        byFile.set(ref.file, existing);
    }

    let shown = 0;
    for (const [file, refs] of byFile) {
        if (shown >= maxReferences) {
            lines.push(`  ... and ${impact.references.length - shown} more references`);
            break;
        }
        lines.push(`  📄 ${file}:`);
        for (const ref of refs.slice(0, 3)) {
            lines.push(`     L${ref.line}: ${ref.context}`);
            shown++;
            if (shown >= maxReferences) break;
        }
        if (refs.length > 3) {
            lines.push(`     ... and ${refs.length - 3} more in this file`);
        }
    }

    lines.push('');
    lines.push('Deleting this may break these references. Consider updating them first.');
    
    return lines.join('\n');
}


