#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as os from 'os';
import { allTools, getAllowedWorkflowModesForTool, isToolAvailableInWorkflowMode } from './tools/index.js';
import { getWorkspaceRoot } from './tools/common.js';
import { createToolRegistry, createPluginLifecycleManager, type Tool } from './tools/registry/index.js';
import { preferencesState } from './tools/preferences/preferences-state.js';
import { crudToolBuckets } from './tools/crud/index.js';
import { preloadShapeCatalog, SHACL_CRUD_TOOL_NAMES } from './tools/crud/shacl-crud.js';

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
    console.error(`[oml-mcp-server] cwd: ${process.cwd()}`);
    console.error(`[oml-mcp-server] argv: ${process.argv.join(' | ')}`);
    console.error(`[oml-mcp-server] PWD env: ${process.env.PWD || '(not set)'}`);
    console.error(`[oml-mcp-server] INIT_CWD env: ${process.env.INIT_CWD || '(not set)'}`);
    if (workspaceRoot === os.homedir()) {
        console.error(
            '[oml-mcp-server] WARNING: workspace root resolved to home directory. ' +
            'Set OML_WORKSPACE_ROOT or pass --workspace <path> to enable reliable shape discovery.',
        );
    }
    
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

    const availableCrudTools = SHACL_CRUD_TOOL_NAMES.filter((name) => allTools.some((toolReg) => toolReg.tool.name === name));
    console.error(
        `[oml-mcp-server] SHACL CRUD tools registered: ${availableCrudTools.length}/${SHACL_CRUD_TOOL_NAMES.length} ` +
        `(${availableCrudTools.join(', ')})`,
    );
    console.error(
        `[oml-mcp-server] SHACL CRUD buckets: ` +
       // `discovery=${crudToolBuckets.discovery.length}, ` +
        `create=${crudToolBuckets.create.length}, ` +
        `update=${crudToolBuckets.update.length}, ` +
        `delete=${crudToolBuckets.delete.length}`,
    );

    try {
        const preload = await preloadShapeCatalog();
        console.error(
            `[oml-mcp-server] SHACL shape catalog preloaded: ${preload.shapeCount} shapes (workspace: ${preload.workspace})`,
        );
        if (preload.shapeCount > 0) {
            console.error(`[oml-mcp-server] SHACL target classes: ${preload.targetClasses.join(', ')}`);
        }
    } catch (error) {
        console.error('[oml-mcp-server] Failed to preload SHACL shape catalog:', error);
    }
    
    // Create MCP server
    const server = new McpServer({
        name: 'oml-mcp-server',
        version: '0.1.0',
    });

    // Register all tools dynamically from registry
    const tools = registry.getAllTools();
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
