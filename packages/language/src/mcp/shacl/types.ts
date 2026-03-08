export interface PropertyConstraint {
    path: string;              // e.g., "base:description"
    minCount?: number;         // Required if > 0
    maxCount?: number;
    datatype?: string;         // e.g., "xsd:string"
    class?: string;            // e.g., "requirement:Stakeholder"
    message?: string;          // Validation error message
}

export interface ShapeDefinition {
    shapeUri: string;          // e.g., "requirement:RequirementStakeholderRulesShape"
    targetClass: string;       // e.g., "requirement:Requirement"
    properties: PropertyConstraint[];
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
