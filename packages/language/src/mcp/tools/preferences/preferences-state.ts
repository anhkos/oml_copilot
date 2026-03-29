/**
 * Preferences and planning context state for the MCP server.
 * Supports RLHF-style feedback collection and user-specific policies.
 */

export type AutonomyMode = 'confirm' | 'batch' | 'auto';
export type WorkflowMode = 'basic' | 'methodology' | 'shape_modeling';

export interface UserPreferences {
    autonomy: AutonomyMode;
    workflowMode?: WorkflowMode;
    policies?: string[];
    metadata?: Record<string, unknown>;
    /** 
     * Safe mode: when enabled, automatically runs validate_oml after mutations to catch errors early.
     * Applies to term creation, instance creation, axiom modifications, and property updates.
     * Does NOT automatically run ensure_imports - that must be called explicitly if needed.
     * Recommended for weaker models to catch errors early.
     */
    safeMode?: boolean;
    /**
     * Strict methodology routing: when enabled in methodology mode, direct mutation tools are blocked.
     * Models must use route_shape_intent for modeling changes.
     */
    strictMethodologyRouting?: boolean;
}

export interface FeedbackEntry {
    timestamp: string;
    toolName: string;
    params: unknown;
    outcome: 'approved' | 'rejected' | 'modified';
    userComment?: string;
    preferences: UserPreferences;
}

function getDefaultWorkflowMode(): WorkflowMode {
    const fromEnv = (process.env.OML_DEFAULT_WORKFLOW_MODE || '').trim();
    if (fromEnv === 'basic' || fromEnv === 'methodology' || fromEnv === 'shape_modeling') {
        return fromEnv;
    }
    return 'basic';
}

class PreferencesState {
    private preferences: UserPreferences = {
        autonomy: 'confirm',
        workflowMode: getDefaultWorkflowMode(),
        policies: [],
        safeMode: false,
        strictMethodologyRouting: false,
    };

    private feedbackLog: FeedbackEntry[] = [];

    getPreferences(): UserPreferences {
        return { ...this.preferences };
    }

    setPreferences(prefs: Partial<UserPreferences>): UserPreferences {
        this.preferences = {
            ...this.preferences,
            ...prefs,
        };
        return this.getPreferences();
    }

    logFeedback(entry: Omit<FeedbackEntry, 'timestamp' | 'preferences'>): void {
        this.feedbackLog.push({
            ...entry,
            timestamp: new Date().toISOString(),
            preferences: this.getPreferences(),
        });
    }

    getFeedbackLog(): FeedbackEntry[] {
        return [...this.feedbackLog];
    }

    clearFeedbackLog(): void {
        this.feedbackLog = [];
    }

    getContextPrompt(): string {
        const { autonomy, workflowMode, policies, safeMode, strictMethodologyRouting } = this.preferences;
        
        let prompt = `Current user preferences:\n`;
        prompt += `- Autonomy mode: ${autonomy}\n`;
        prompt += `- Workflow mode: ${workflowMode ?? 'basic'}\n`;
        if ((workflowMode ?? 'basic') === 'basic') {
            prompt += `  → Methodology-editing tools are hidden/blocked unless you switch to methodology mode.\n`;
        } else if ((workflowMode ?? 'basic') === 'shape_modeling') {
            prompt += `  → Shape-aware description workflow is enforced.\n`;
            prompt += `  → Use add_instance/update_instance_with_shape/delete_instance_with_shape for SHACL-aware mutations.\n`;
            prompt += `  → Ask only for missing required SHACL properties before mutating files.\n`;
        } else {
            prompt += `  → Methodology-aware tools are enabled (validation/enforcement plus guided modeling workflows).\n`;
        }
        
        if (autonomy === 'confirm') {
            prompt += `  → Ask for confirmation before executing each tool call.\n`;
        } else if (autonomy === 'batch') {
            prompt += `  → Present a plan with all tool calls, ask for approval once, then execute.\n`;
        } else if (autonomy === 'auto') {
            prompt += `  → Execute tool calls automatically, but validate first; fall back to confirm if validation fails.\n`;
        }

        prompt += `- Safe mode: ${safeMode ? 'enabled' : 'disabled'}\n`;
        if (safeMode) {
            prompt += `  → Mutations will automatically run validate_oml to catch errors early.\n`;
            prompt += `  → Note: ensure_imports is NOT run automatically; call it explicitly if needed.\n`;
        }

        prompt += `- Strict methodology routing: ${strictMethodologyRouting ? 'enabled' : 'disabled'}\n`;
        if (strictMethodologyRouting) {
            prompt += `  → In methodology mode, direct mutation tools are blocked; use route_shape_intent for model edits.\n`;
        }

        if (policies && policies.length > 0) {
            prompt += `- User policies:\n`;
            for (const policy of policies) {
                prompt += `  → ${policy}\n`;
            }
        }

        return prompt;
    }
}

// Global singleton instance
export const preferencesState = new PreferencesState();
