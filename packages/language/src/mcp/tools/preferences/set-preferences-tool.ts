import { z } from 'zod';
import { preferencesState } from './preferences-state.js';

const setPreferencesSchema = {
    autonomy: z.enum(['confirm', 'batch', 'auto']).optional().describe('Autonomy mode: confirm (ask before each tool), batch (ask once for plan), auto (execute with validation)'),
    workflowMode: z.enum(['basic', 'methodology', 'methodology_coding']).optional().describe('Workflow mode: basic (core OML operations) or methodology (methodology-aware validation/enforcement and coding). Note: methodology_coding is accepted as a backward-compatible alias for methodology.'),
    policies: z.array(z.string()).optional().describe('User policies like "never add imports automatically", "prefer reusing existing concepts", etc.'),
    safeMode: z.boolean().optional().describe('Enable safe mode to automatically validate OML after mutations. Recommended for ensuring code correctness. When enabled, mutation tools will run validation and report any errors.'),
    strictMethodologyRouting: z.boolean().optional().describe('When true (and workflowMode=methodology), blocks direct mutation tools and requires route_shape_intent for modeling edits. Recommended for smaller models.'),
};

export const setPreferencesTool = {
    name: 'set_preferences' as const,
    description: 'Configure user preferences for tool execution and planning. Sets autonomy mode, workflow mode, safe mode, and optional policies that guide how the agent uses tools. Use workflow mode to control dynamic exposure between core modeling and methodology-aware operations. Enable safeMode for automatic validation after mutations - recommended for catching errors early.',
    paramsSchema: setPreferencesSchema,
};

export const setPreferencesHandler = async (
    params: { autonomy?: 'confirm' | 'batch' | 'auto'; workflowMode?: 'basic' | 'methodology' | 'methodology_coding'; policies?: string[]; safeMode?: boolean; strictMethodologyRouting?: boolean }
): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
    try {
        const current = preferencesState.getPreferences();
        const normalizedWorkflowMode = params.workflowMode === 'methodology_coding' ? 'methodology' : params.workflowMode;
        const autoStrictRouting =
            normalizedWorkflowMode === 'methodology' &&
            params.strictMethodologyRouting === undefined &&
            current.strictMethodologyRouting !== true;

        const normalizedParams = {
            ...params,
            workflowMode: normalizedWorkflowMode,
            strictMethodologyRouting:
                params.strictMethodologyRouting ?? (autoStrictRouting ? true : current.strictMethodologyRouting),
        };

        preferencesState.setPreferences(normalizedParams);

        const contextPrompt = preferencesState.getContextPrompt();
        const autoStrictNote = autoStrictRouting
            ? '\n\nℹ️ strictMethodologyRouting was automatically enabled for workflowMode="methodology". Set strictMethodologyRouting=false to allow direct mutation tools.'
            : '';

        return {
            content: [
                {
                    type: 'text' as const,
                    text: `✓ Preferences updated\n\n${contextPrompt}${autoStrictNote}`,
                },
            ],
        };
    } catch (error) {
        return {
            content: [
                {
                    type: 'text' as const,
                    text: `Error setting preferences: ${error instanceof Error ? error.message : String(error)}`,
                },
            ],
        };
    }
};
