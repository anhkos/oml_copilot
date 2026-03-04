/**
 * Parsing Module Exports
 * 
 * Centralized exports for all parsing-related modules and utilities.
 */

export type { PropertyAssertion, InstanceInfo, ImportPrefixMap, ParsedDescription, ParsingConfig, ResolvedImports } from './types.js';

// Import resolver functions
export {
    buildImportPrefixMap,
    resolveImportAlias,
    normalizeTypes,
    getCanonicalType,
    scanForOmlFiles,
    findImportedFiles,
} from './import-resolver.js';

// Description parser functions
export { parseDescriptionAst } from './description-parser.js';
