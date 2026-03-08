#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as fs from 'fs';
import * as path from 'path';
import { allTools, getAllowedWorkflowModesForTool, isToolAvailableInWorkflowMode } from './tools/index.js';
import { getWorkspaceRoot } from './tools/common.js';
import { createToolRegistry, createPluginLifecycleManager, type Tool } from './tools/registry/index.js';
import { preferencesState } from './tools/preferences/preferences-state.js';
import { parseAllShapes } from './shacl/parser.js';
import { ShapeBasedToolGenerator } from './shacl/tool-generator.js';
import { ShapeBasedHandlerFactory } from './shacl/tool-handlers.js';
import type { MCPToolDefinition } from './shacl/types.js';
import { z } from 'zod';

/** Dynamic tools generated from SHACL shapes at startup */
const dynamicTools = new Map<string, { definition: MCPToolDefinition; handler: (params: any) => Promise<any> }>();
const registeredDynamicToolNames = new Set<string>();

let shaclReloadInProgress = false;
let shaclReloadQueued = false;

function buildZodShape(definition: MCPToolDefinition): Record<string, any> {
    const zodShape: Record<string, any> = {};
    for (const [paramName, paramDef] of Object.entries(definition.inputSchema.properties)) {
        const def = paramDef as any;
        let zodType;
        switch (def.type) {
            case 'integer':
                zodType = z.number().int();
                break;
            case 'number':
                zodType = z.number();
                break;
            case 'boolean':
                zodType = z.boolean();
                break;
            default:
                zodType = z.string();
        }
        zodType = zodType.describe(def.description || paramName);
        if (!definition.inputSchema.required.includes(paramName)) {
            zodType = zodType.optional();
        }
        zodShape[paramName] = zodType;
    }
    return zodShape;
}

function registerDynamicTool(server: McpServer, name: string): void {
    if (registeredDynamicToolNames.has(name)) {
        return;
    }

    const entry = dynamicTools.get(name);
    if (!entry) {
        return;
    }

    server.tool(
        name,
        entry.definition.description,
        buildZodShape(entry.definition),
        async (params: any) => {
            const current = dynamicTools.get(name);
            if (!current) {
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: `Dynamic tool '${name}' is no longer available. Restart MCP server to refresh tool list.`,
                        },
                    ],
                };
            }
            try {
                return await current.handler(params);
            } catch (error) {
                console.error(`[oml-mcp-server] Error in dynamic tool '${name}':`, error);
                throw error;
            }
        },
    );

    registeredDynamicToolNames.add(name);
    console.error(`[oml-mcp-server] Registered dynamic tool: ${name}`);
}

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
 * Build dynamic SHACL-driven tools from workspace shape files
 */
async function rebuildShaclTools(workspacePath: string): Promise<void> {
    dynamicTools.clear();

    try {
        const shapes = await parseAllShapes(workspacePath);
        if (shapes.length === 0) {
            console.error(`[oml-mcp-server] No SHACL shapes found in workspace`);
            return;
        }
        console.error(`[oml-mcp-server] Loaded ${shapes.length} SHACL shapes`);

        const toolGenerator = new ShapeBasedToolGenerator();
        const handlerFactory = new ShapeBasedHandlerFactory();

        for (const shape of shapes) {
            const tools = toolGenerator.generateToolsForShape(shape);

            for (const tool of tools) {
                let handler: (params: any) => Promise<any>;
                if (tool.name.startsWith('add_')) {
                    handler = handlerFactory.createAddHandler(shape);
                } else if (tool.name.startsWith('update_')) {
                    handler = handlerFactory.createUpdateHandler(shape);
                } else if (tool.name.startsWith('delete_')) {
                    handler = handlerFactory.createDeleteHandler(shape);
                } else if (tool.name.startsWith('get_')) {
                    handler = handlerFactory.createGetHandler(shape);
                } else {
                    continue;
                }

                dynamicTools.set(tool.name, { definition: tool, handler });
            }
        }
    } catch (error) {
        console.error(`[oml-mcp-server] Failed to initialize SHACL tools:`, error);
    }
}

async function refreshShaclTools(server: McpServer, workspacePath: string, reason: string): Promise<void> {
    if (shaclReloadInProgress) {
        shaclReloadQueued = true;
        return;
    }

    shaclReloadInProgress = true;
    try {
        do {
            shaclReloadQueued = false;
            const previousNames = new Set(dynamicTools.keys());

            await rebuildShaclTools(workspacePath);

            const currentNames = new Set(dynamicTools.keys());
            let added = 0;
            for (const name of currentNames) {
                if (!previousNames.has(name)) {
                    added += 1;
                }
                registerDynamicTool(server, name);
            }

            let removed = 0;
            for (const name of previousNames) {
                if (!currentNames.has(name)) {
                    removed += 1;
                }
            }

            console.error(
                `[oml-mcp-server] SHACL refresh (${reason}) complete: ${currentNames.size} active tools (${added} added, ${removed} removed)`,
            );

            if (removed > 0) {
                console.error('[oml-mcp-server] Removed dynamic tools stay visible until server restart (MCP has no unregister API).');
            }
        } while (shaclReloadQueued);
    } finally {
        shaclReloadInProgress = false;
    }
}

function startShaclWatcher(server: McpServer, workspacePath: string): void {
    const shapesDir = path.join(workspacePath, 'shapes');
    if (!fs.existsSync(shapesDir)) {
        console.error(`[oml-mcp-server] SHACL watcher disabled (missing directory: ${shapesDir})`);
        return;
    }

    let debounceTimer: NodeJS.Timeout | undefined;
    const scheduleRefresh = () => {
        if (debounceTimer) {
            clearTimeout(debounceTimer);
        }
        debounceTimer = setTimeout(() => {
            void refreshShaclTools(server, workspacePath, 'file-change');
        }, 400);
    };

    const watcher = fs.watch(shapesDir, { recursive: true }, (_eventType, filename) => {
        const name = filename ? String(filename) : '';
        if (name && !name.endsWith('.ttl')) {
            return;
        }

        console.error(`[oml-mcp-server] SHACL change detected: ${name || '(unknown file)'}`);
        scheduleRefresh();
    });

    watcher.on('error', (error) => {
        console.error('[oml-mcp-server] SHACL watcher error:', error);
    });

    process.on('exit', () => watcher.close());
    console.error(`[oml-mcp-server] SHACL watcher enabled on ${shapesDir}`);
}

function registerDynamicIntrospectionTools(server: McpServer): void {
    (server as any).tool(
        'list_dynamic_tools',
        'List currently active SHACL-driven dynamic tools and optional schema details.',
        {
            includeSchema: z.boolean().optional().describe('Include full input schema for each tool'),
        },
        async (params: any) => {
            const includeSchema = params?.includeSchema ?? false;

            const activeTools: any[] = Array.from(dynamicTools.values()).map(({ definition }) => {
                const properties = includeSchema
                    ? definition.inputSchema.properties
                    : Object.keys(definition.inputSchema.properties);

                return {
                    name: definition.name,
                    description: definition.description,
                    required: definition.inputSchema.required,
                    properties,
                };
            });

            const registeredButInactive = Array.from(registeredDynamicToolNames)
                .filter(name => !dynamicTools.has(name))
                .sort();

            const payload: any = {
                activeCount: activeTools.length,
                activeTools,
                registeredButInactive,
                note:
                    registeredButInactive.length > 0
                        ? 'These names remain discoverable until restart because MCP has no unregister API.'
                        : undefined,
            };

            return {
                content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
            };
        },
    );

    (server as any).tool(
        'get_dynamic_tool',
        'Get one SHACL-driven dynamic tool definition by name.',
        {
            toolName: z.string().describe('Dynamic tool name, e.g., add_requirement'),
        },
        async (params: any) => {
            const entry = dynamicTools.get(params.toolName);
            if (!entry) {
                const activeNames = Array.from(dynamicTools.keys()).sort();
                return {
                    isError: true,
                    content: [
                        {
                            type: 'text' as const,
                            text:
                                `Dynamic tool '${params.toolName}' is not active.\n` +
                                `Active tools: ${activeNames.join(', ') || '(none)'}`,
                        },
                    ],
                };
            }

            return {
                content: [
                    {
                        type: 'text' as const,
                        text: JSON.stringify(entry.definition, null, 2),
                    },
                ],
            };
        },
    );
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

    registerDynamicIntrospectionTools(server);

    // Build and register SHACL-driven dynamic tools
    await rebuildShaclTools(workspaceRoot);

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

    for (const name of dynamicTools.keys()) {
        registerDynamicTool(server, name);
    }
    console.error(`[oml-mcp-server] Registered ${dynamicTools.size} SHACL-driven dynamic tools`);

    // Start the server
    const transport = new StdioServerTransport();
    await server.connect(transport);

    startShaclWatcher(server, workspaceRoot);

    console.error('OML MCP Server running on stdio');
    const totalTools = tools.length + dynamicTools.size;
    console.error(`[oml-mcp-server] Total tools loaded: ${totalTools} (${tools.length} static + ${dynamicTools.size} dynamic)`);
}

main().catch((error) => {
    console.error('Server error:', error);
    process.exit(1);
});
