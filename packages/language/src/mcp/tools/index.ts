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
import { crudTools } from './crud/index.js';

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
    ...crudTools,
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

export type WorkflowMode = 'basic' | 'methodology' | 'shape_modeling';

const shapeWorkflowPrimaryTools = new Set<string>([
    'add_instance',
    'update_instance_with_shape',
    'delete_instance_with_shape',
]);

const alwaysAllowedTools = new Set<string>([
    'set_preferences',
    'get_preferences',
    'log_feedback',
    'validate_oml',
    'analyze_impact',
    'suggest_oml_symbols',
]);

export function getAllowedWorkflowModesForTool(toolName: string): WorkflowMode[] | null {
    if (alwaysAllowedTools.has(toolName)) {
        return ['basic', 'methodology', 'shape_modeling'];
    }

    if (shapeWorkflowPrimaryTools.has(toolName)) {
        return ['shape_modeling'];
    }

    if (toolName.startsWith('create_') || toolName.startsWith('update_') || toolName.startsWith('delete_') || toolName.startsWith('add_')) {
        return ['basic', 'methodology'];
    }

    return null;
}

export function isToolAvailableInWorkflowMode(toolName: string, workflowMode: WorkflowMode): boolean {
    // Always-allowed tools are available in every mode
    if (alwaysAllowedTools.has(toolName)) {
        return true;
    }

    if (workflowMode === 'shape_modeling') {
        // In shape modeling mode, only shape tools (and always-allowed above) are exposed
        return shapeWorkflowPrimaryTools.has(toolName);
    }

    // In basic/methodology modes, shape tools are not available
    if (shapeWorkflowPrimaryTools.has(toolName)) {
        return false;
    }

    return true;
}

export const allTools: ToolRegistration[] = [
    ...coreTools,
    ...pendingTools.map((p) => ({ tool: p.tool, handler: p.handler }))
];
