/**
 * Parsing Types and Interfaces
 * 
 * Shared TypeScript interfaces for parsing results and intermediate data structures.
 * Ensures type safety across parsing, validation, and reporting modules.
 */

/**
 * A single property assertion extracted from an instance
 * Represents a property value on an instance in a description
 */
export interface PropertyAssertion {
    /** Qualified property name (e.g., "requirement:isExpressedBy") */
    propertyName: string;
    /** Property name with canonical prefix */
    propertyQualified: string;
    /** Values assigned to this property */
    values: string[];
    /** Instance that owns this property */
    instanceName: string;
    /** Types of the instance */
    instanceTypes: string[];
    /** Line number in source file (for error reporting) */
    line?: number;
}

/**
 * Basic information about an instance in a description
 */
export interface InstanceInfo {
    /** Instance name */
    name: string;
    /** Type(s) of the instance */
    types: string[];
    /** Line number in source file */
    line?: number;
}

/**
 * Map from import prefix alias to canonical prefix
 * Example: { "ent" => "entity" } for `uses <.../entity#> as ent`
 */
export interface ImportPrefixMap {
    [alias: string]: string;
}

/**
 * Result of parsing an OML description file
 */
export interface ParsedDescription {
    /** Property assertions extracted from instances */
    assertions: PropertyAssertion[];
    /** All instances found in the description */
    instances: InstanceInfo[];
    /** Raw source code */
    sourceCode: string;
    /** Map of import aliases to canonical prefixes */
    importPrefixMap: ImportPrefixMap;
}

/**
 * Configuration for description parsing
 */
export interface ParsingConfig {
    /** Include full workspace context (slower, but enables full validation) */
    includeWorkspaceContext?: boolean;
    /** Maximum directory depth to scan for imports */
    maxScanDepth?: number;
    /** Workspace root directory for import resolution */
    workspaceRoot?: string;
    /** Whether to resolve imports (default true) */
    resolveImports?: boolean;
}

/**
 * Result of resolving imports for a description
 */
export interface ResolvedImports {
    /** Direct imports specified in the description */
    directImports: string[];
    /** Files containing those imports */
    importedFiles: Map<string, string>; // namespace => file path
    /** Unresolved imports (not found in workspace) */
    unresolved: string[];
}
