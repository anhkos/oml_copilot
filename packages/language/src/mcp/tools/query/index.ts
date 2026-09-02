export { 
    suggestOmlSymbolsTool,
    suggestOmlSymbolsMetadata,
    suggestOmlSymbolsHandler, 
    type SymbolSuggestion, 
    type SuggestSymbolsResult,
    type OmlSymbolType,
    OML_SYMBOL_KINDS,
    ENTITY_SYMBOL_KINDS,
    SYMBOL_KIND_TO_OML_TYPES,
    ENTITY_TYPES,
} from './suggest-oml-symbols.js';

export {
    resolveSymbolName,
    resolveSymbolNames,
    formatDisambiguationError,
    createResolutionErrorResult,
    type SymbolResolution,
} from './resolve-symbol.js';

export {
    analyzeImpactTool,
    analyzeImpactMetadata,
    analyzeImpactHandler,
} from './analyze-impact.js';

export {
    parseVocabularyForProperties,
    type ExtractedRelation,
    type ExtractedScalarProperty,
    type VocabularyProperties,
} from './parse-vocabulary.js';

export {
    compareDescriptionsTool,
    compareDescriptionsMetadata,
    compareDescriptionsHandler,
} from './compare-descriptions.js';
