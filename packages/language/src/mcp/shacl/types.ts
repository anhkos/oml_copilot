export interface PropertyConstraint {
    path: string;              // e.g., "base:description"
    name?: string;             // Human-readable label from sh:name
    minCount?: number;         // Required if > 0
    maxCount?: number;
    datatype?: string;         // e.g., "xsd:string"
    class?: string;            // e.g., "requirement:Stakeholder"
    message?: string;          // Validation error message
    editor?: string;           // Optional dash:editor UI hint
}

export interface ShapeDefinition {
    shapeUri: string;          // e.g., "requirement:RequirementStakeholderRulesShape"
    targetClass: string;       // e.g., "requirement:Requirement"
    properties: PropertyConstraint[];
    filePath?: string;         // Source markdown/ttl file path
    contextUri?: string;       // Optional context URI from markdown frontmatter
}

export interface MCPToolDefinition {
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: Record<string, any>;
        required: string[];
    };
}
