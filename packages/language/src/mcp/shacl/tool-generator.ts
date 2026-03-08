import type { ShapeDefinition, PropertyConstraint, MCPToolDefinition } from './types.js';

export class ShapeBasedToolGenerator {

    generateToolsForShape(shape: ShapeDefinition): MCPToolDefinition[] {
        const className = this.extractClassName(shape.targetClass);

        return [
            this.generateAddTool(className, shape),
            this.generateUpdateTool(className, shape),
            this.generateDeleteTool(className, shape),
            this.generateGetTool(className, shape),
        ];
    }

    private generateAddTool(className: string, shape: ShapeDefinition): MCPToolDefinition {
        const params: Record<string, any> = {
            name: {
                type: 'string',
                description: `Name/identifier for the new ${className} instance`,
            },
            descriptionFile: {
                type: 'string',
                description: 'Path to the description file where the instance will be added',
            },
        };

        const required = ['name', 'descriptionFile'];

        for (const prop of shape.properties) {
            const paramName = this.propertyToParamName(prop.path);
            params[paramName] = this.propertyToParamDefinition(prop);

            if (prop.minCount && prop.minCount > 0) {
                required.push(paramName);
            }
        }

        return {
            name: `add_${className.toLowerCase()}`,
            description: `Add a new ${shape.targetClass} instance to a description file. ${this.generateConstraintSummary(shape)}`,
            inputSchema: {
                type: 'object',
                properties: params,
                required,
            },
        };
    }

    private generateUpdateTool(className: string, shape: ShapeDefinition): MCPToolDefinition {
        const params: Record<string, any> = {
            instanceName: {
                type: 'string',
                description: `Name of the ${className} instance to update`,
            },
            descriptionFile: {
                type: 'string',
                description: 'Path to the description file containing the instance',
            },
        };

        for (const prop of shape.properties) {
            const paramName = this.propertyToParamName(prop.path);
            const paramDef = this.propertyToParamDefinition(prop);
            paramDef.description = `(Optional) New value for ${prop.path}`;
            params[paramName] = paramDef;
        }

        return {
            name: `update_${className.toLowerCase()}`,
            description: `Update an existing ${shape.targetClass} instance`,
            inputSchema: {
                type: 'object',
                properties: params,
                required: ['instanceName', 'descriptionFile'],
            },
        };
    }

    private generateDeleteTool(className: string, shape: ShapeDefinition): MCPToolDefinition {
        return {
            name: `delete_${className.toLowerCase()}`,
            description: `Delete a ${shape.targetClass} instance from a description file`,
            inputSchema: {
                type: 'object',
                properties: {
                    instanceName: {
                        type: 'string',
                        description: `Name of the ${className} instance to delete`,
                    },
                    descriptionFile: {
                        type: 'string',
                        description: 'Path to the description file containing the instance',
                    },
                },
                required: ['instanceName', 'descriptionFile'],
            },
        };
    }

    private generateGetTool(className: string, shape: ShapeDefinition): MCPToolDefinition {
        return {
            name: `get_${className.toLowerCase()}`,
            description: `Retrieve details of a ${shape.targetClass} instance`,
            inputSchema: {
                type: 'object',
                properties: {
                    instanceName: {
                        type: 'string',
                        description: `Name of the ${className} instance to retrieve`,
                    },
                    descriptionFile: {
                        type: 'string',
                        description: 'Path to the description file containing the instance',
                    },
                },
                required: ['instanceName', 'descriptionFile'],
            },
        };
    }

    private propertyToParamName(propPath: string): string {
        const parts = propPath.split(':');
        return parts.length > 1 ? parts[1] : propPath;
    }

    private propertyToParamDefinition(prop: PropertyConstraint): any {
        const def: any = {
            description: prop.message || `Value for ${prop.path}`,
        };

        if (prop.datatype) {
            def.type = this.mapDatatypeToJsonType(prop.datatype);
        } else if (prop.class) {
            def.type = 'string';
            def.description += ` (must reference a ${prop.class} instance)`;
        } else {
            def.type = 'string';
        }

        if (prop.minCount && prop.minCount > 0) {
            def.description += ' [REQUIRED]';
        }

        return def;
    }

    private mapDatatypeToJsonType(datatype: string): string {
        if (datatype.includes('string')) return 'string';
        if (datatype.includes('integer') || datatype.includes('int')) return 'integer';
        if (datatype.includes('decimal') || datatype.includes('double') || datatype.includes('float')) return 'number';
        if (datatype.includes('boolean')) return 'boolean';
        if (datatype.includes('dateTime') || datatype.includes('date')) return 'string';
        return 'string';
    }

    private extractClassName(qualifiedName: string): string {
        const parts = qualifiedName.split(':');
        return parts.length > 1 ? parts[1] : qualifiedName;
    }

    private generateConstraintSummary(shape: ShapeDefinition): string {
        const required = shape.properties
            .filter(p => p.minCount && p.minCount > 0)
            .map(p => p.path);

        if (required.length === 0) return '';
        return `Required properties: ${required.join(', ')}`;
    }
}

export function generateAllTools(shapes: ShapeDefinition[]): MCPToolDefinition[] {
    const generator = new ShapeBasedToolGenerator();
    const allTools: MCPToolDefinition[] = [];

    for (const shape of shapes) {
        const tools = generator.generateToolsForShape(shape);
        allTools.push(...tools);
        console.error(`[shacl-tools] Generated ${tools.length} tools for ${shape.targetClass}`);
    }

    return allTools;
}
