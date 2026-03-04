#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { allTools, getAllowedWorkflowModesForTool, isToolAvailableInWorkflowMode } from './tools/index.js';
import { getWorkspaceRoot } from './tools/common.js';
import { createToolRegistry, createPluginLifecycleManager, type Tool } from './tools/registry/index.js';
import { preferencesState } from './tools/preferences/preferences-state.js';

const methodologyDirectMutationTools = new Set<string>([
    'create_aspect',
    'create_concept',
    'create_relation',
    'create_relation_entity',
    'create_scalar',
    'create_scalar_property',
    'create_annotation_property',
    'delete_term',
    'update_term',
    'add_specialization',
    'delete_specialization',
    'add_restriction',
    'update_restriction',
    'delete_restriction',
    'add_equivalence',
    'update_equivalence',
    'delete_equivalence',
    'update_annotation',
    'delete_annotation',
    'update_key',
    'delete_key',
    'create_concept_instance',
    'create_relation_instance',
    'update_instance',
    'delete_instance',
    'update_property_value',
    'delete_property_value',
    'delete_type_assertion',
    'create_ontology',
    'add_import',
    'delete_import',
    'delete_ontology',
    'create_rule',
    'update_rule',
    'delete_rule',
]);

/**
 * Initialize and register all tools with the registry
 */
async function initializeToolRegistry() {
    const registry = await createToolRegistry();
    
    // Register all tools with their metadata
    for (const toolReg of allTools) {
        registry.registerTool(
            toolReg.tool as Tool,
            toolReg.tool.name,
            toolReg.metadata
        );
    }
    
    return registry;
}

/**
 * Main server initialization with plugin lifecycle management
 */
async function main() {
    // Log workspace root for debugging
    const workspaceRoot = getWorkspaceRoot();
    console.error(`[oml-mcp-server] Workspace root: ${workspaceRoot}`);
    console.error(`[oml-mcp-server] OML_WORKSPACE_ROOT env: ${process.env.OML_WORKSPACE_ROOT || '(not set, using cwd)'}`);
    
    // Initialize tool registry
    const registry = await initializeToolRegistry();
    
    // Initialize plugin lifecycle manager
    const lifecycleManager = await createPluginLifecycleManager();
    
    // Log registry stats
    console.error(`[oml-mcp-server] Tool registry initialized with ${registry.getToolCount()} tools`);
    const layerStats = registry.getCountByLayer();
    for (const [layer, count] of Object.entries(layerStats)) {
        console.error(`[oml-mcp-server]   ${layer}: ${count} tools`);
    }
    
    // Create MCP server
    const server = new McpServer({
        name: 'oml-mcp-server',
        version: '0.1.0',
    });

    // Register all tools dynamically from registry
    const tools = registry.getAllTools();
    const methodologyTools = tools
        .filter((entry) => entry.metadata?.layer === 'methodology')
        .map((entry) => entry.tool.name)
        .sort();
    console.error(`[oml-mcp-server] Methodology tools exposed: ${methodologyTools.join(', ') || '(none)'}`);
    for (const entry of tools) {
        const { tool } = entry;
        
        // Get the handler from the allTools array to maintain closure
        const toolReg = allTools.find(t => t.tool.name === tool.name);
        if (!toolReg) continue;
        
        const handler = toolReg.handler;
        
        // Register tool with lifecycle tracking
        await lifecycleManager.emitEvent('LOADED' as any, tool.name);
        
        server.tool(
            tool.name,
            tool.description,
            tool.paramsSchema as any,
            async (...args: any[]) => {
                try {
                    const preferences = preferencesState.getPreferences();
                    const workflowMode = preferences.workflowMode ?? 'basic';
                    if (!isToolAvailableInWorkflowMode(tool.name, workflowMode)) {
                        const allowedModes = getAllowedWorkflowModesForTool(tool.name) ?? ['basic'];
                        const preferredMode = allowedModes[0];
                        return {
                            content: [
                                {
                                    type: 'text' as const,
                                    text:
                                        `Tool '${tool.name}' is unavailable in workflow mode '${workflowMode}'.\n` +
                                        `Allowed workflow modes for this tool: ${allowedModes.join(', ')}\n` +
                                        `Switch modes first:\n` +
                                        `set_preferences({ workflowMode: "${preferredMode}" })`,
                                },
                            ],
                        };
                    }

                    if (
                        workflowMode === 'methodology' &&
                        preferences.strictMethodologyRouting &&
                        methodologyDirectMutationTools.has(tool.name)
                    ) {
                        return {
                            content: [
                                {
                                    type: 'text' as const,
                                    text:
                                        `Tool '${tool.name}' is blocked by strict methodology routing.\n` +
                                        `Use route_shape_intent for methodology-aware model edits (e.g., intent: \"add stakeholder\").\n` +
                                        `Disable strict routing if needed:\n` +
                                        `set_preferences({ strictMethodologyRouting: false })`,
                                },
                            ],
                            isError: true,
                        };
                    }

                    // Increment usage tracking
                    registry.recordUsage(tool.name);
                    
                    // Execute handler
                    const result = await handler(...args);
                    
                    // Record success
                    await lifecycleManager.emitEvent('ENABLED' as any, tool.name);
                    
                    return result;
                } catch (error) {
                    console.error(`[oml-mcp-server] Error in tool '${tool.name}':`, error);
                    await lifecycleManager.emitEvent('DISABLED' as any, tool.name, String(error));
                    throw error;
                }
            }
        );
    }

    // Start the server
    const transport = new StdioServerTransport();
    await server.connect(transport);

    console.error('OML MCP Server running on stdio');
    console.error(`[oml-mcp-server] Total tools loaded: ${tools.length}`);
}

main().catch((error) => {
    console.error('Server error:', error);
    process.exit(1);
});
