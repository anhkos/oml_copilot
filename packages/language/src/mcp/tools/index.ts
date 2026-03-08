import type { ToolRegistration } from './types.js';
import { termTools } from './terms/index.js';
import { axiomTools } from './axioms/index.js';
import { instanceTools } from './instances/index.js';
import { ontologyTools } from './ontology/index.js';
import { ruleTools } from './rules/index.js';
import { validateOmlHandler, validateOmlTool, validateOmlMetadata } from './validate-tool.js';
import { pendingTools } from './stubs/pending-tools.js';

import { suggestOmlSymbolsTool, analyzeImpactTool, analyzeImpactHandler, suggestOmlSymbolsMetadata, analyzeImpactMetadata } from './query/index.js';
import { suggestOmlSymbolsHandler } from './query/suggest-oml-symbols.js';
import { preferencesTools } from './preferences/index.js';

const coreTools: ToolRegistration[] = [
    { tool: validateOmlTool, handler: validateOmlHandler, metadata: validateOmlMetadata },
    { tool: suggestOmlSymbolsTool, handler: suggestOmlSymbolsHandler, metadata: suggestOmlSymbolsMetadata },
    { tool: analyzeImpactTool, handler: analyzeImpactHandler, metadata: analyzeImpactMetadata },
    ...termTools,
    ...axiomTools,
    ...instanceTools,
    ...ontologyTools,
    ...ruleTools,
    ...preferencesTools,
];

const coreToolsByName = new Map(coreTools.map((t) => [t.tool.name, t]));

function pickTools(names: string[]): ToolRegistration[] {
    return names.map((name) => {
        const tool = coreToolsByName.get(name);
        if (!tool) {
            throw new Error(`Tool "${name}" is not registered in coreTools`);
        }
        return tool;
    });
}

export const phase1Tools: ToolRegistration[] = pickTools([
    'validate_oml',
    'create_aspect',
    'create_concept',
    'create_relation_entity',
    'create_scalar',
    'create_scalar_property',
    'create_annotation_property',
    'create_relation',
    'delete_term',
    'add_specialization',
    'delete_specialization',
]);

export const phase2Tools: ToolRegistration[] = pickTools([
    'add_restriction',
    'create_concept_instance',
    'create_relation_instance',
    'delete_instance',
    'update_instance',
]);

export const phase3Tools: ToolRegistration[] = pickTools([
    'create_ontology',
    'add_import',
    'delete_import',
    'delete_ontology',
    'add_equivalence',
    'delete_equivalence',
    'delete_restriction',
    'delete_annotation',
    'delete_key',
    'create_rule',
    'delete_rule',
    'update_rule',
    'update_term',
    'update_property_value',
    'delete_property_value',
    'delete_type_assertion',
    'update_annotation',
    'update_key',
    'update_equivalence',
    'update_restriction',
]);

export type WorkflowMode = 'basic' | 'methodology';

export function getAllowedWorkflowModesForTool(_toolName: string): WorkflowMode[] | null {
    return null;
}

export function isToolAvailableInWorkflowMode(_toolName: string, _workflowMode: WorkflowMode): boolean {
    return true;
}

export const allTools: ToolRegistration[] = [
    ...coreTools,
    ...pendingTools.map((p) => ({ tool: p.tool, handler: p.handler }))
];
