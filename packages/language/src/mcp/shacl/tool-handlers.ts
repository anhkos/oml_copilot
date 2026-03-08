import * as fs from 'fs';
import { getRelativeWorkspacePath, resolveWorkspacePath } from '../services/workspace-resolver.js';
import type { ShapeDefinition, PropertyConstraint } from './types.js';

// ─────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────

export class ShapeValidator {

    validate(data: Record<string, any>, shape: ShapeDefinition): string[] {
        const errors: string[] = [];

        for (const prop of shape.properties) {
            const paramName = this.getParamName(prop.path);
            const value = data[paramName];

            if (prop.minCount && prop.minCount > 0) {
                if (value === undefined || value === null || value === '') {
                    errors.push(
                        prop.message || `${prop.path} is required (minCount: ${prop.minCount})`
                    );
                }
            }

            if (value !== undefined && value !== null && value !== '' && prop.datatype) {
                if (!this.validateDatatype(value, prop.datatype)) {
                    errors.push(`${prop.path} must be of type ${prop.datatype}`);
                }
            }
        }

        return errors;
    }

    private getParamName(path: string): string {
        const parts = path.split(':');
        return parts.length > 1 ? parts[1] : path;
    }

    private validateDatatype(value: any, datatype: string): boolean {
        if (datatype.includes('string')) return typeof value === 'string';
        if (datatype.includes('integer') || datatype.includes('int')) return Number.isInteger(value);
        if (datatype.includes('decimal') || datatype.includes('double') || datatype.includes('float')) return typeof value === 'number';
        if (datatype.includes('boolean')) return typeof value === 'boolean';
        return true;
    }
}

// ─────────────────────────────────────────────────────────────────
// OML Generation
// ─────────────────────────────────────────────────────────────────

export class OMLInstanceGenerator {

    generateInstance(
        name: string,
        targetClass: string,
        data: Record<string, any>,
        shape: ShapeDefinition,
    ): string {
        const lines: string[] = [];
        const seenPropertyValuePairs = new Set<string>();

        lines.push(`    instance ${name} : ${targetClass} [`);

        for (const prop of shape.properties) {
            const paramName = this.getParamName(prop.path);
            const value = data[paramName];

            if (value !== undefined && value !== null && value !== '') {
                const formattedValue = this.formatValue(value, prop);
                const dedupKey = `${prop.path}::${formattedValue}`;
                if (seenPropertyValuePairs.has(dedupKey)) {
                    continue;
                }
                seenPropertyValuePairs.add(dedupKey);
                lines.push(`        ${prop.path} ${formattedValue}`);
            }
        }

        lines.push(`    ]`);

        return lines.join('\n');
    }

    private getParamName(path: string): string {
        const parts = path.split(':');
        return parts.length > 1 ? parts[1] : path;
    }

    private formatValue(value: any, prop: PropertyConstraint): string {
        if (prop.class) {
            return String(value);
        }
        if (prop.datatype && prop.datatype.includes('string')) {
            return `"${this.escapeString(String(value))}"`;
        }
        return String(value);
    }

    private escapeString(str: string): string {
        return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    }
}

// ─────────────────────────────────────────────────────────────────
// Handler Factory
// ─────────────────────────────────────────────────────────────────

export class ShapeBasedHandlerFactory {
    private validator = new ShapeValidator();
    private generator = new OMLInstanceGenerator();

    createAddHandler(shape: ShapeDefinition) {
        return async (params: Record<string, any>) => {
            const errors = this.validator.validate(params, shape);
            if (errors.length > 0) {
                return {
                    isError: true,
                    content: [{
                        type: 'text' as const,
                        text: `Validation errors:\n${errors.map(e => `  - ${e}`).join('\n')}`,
                    }],
                };
            }

            const instanceOml = this.generator.generateInstance(
                params.name,
                shape.targetClass,
                params,
                shape,
            );

            const requestedPath = String(params.descriptionFile ?? '');
            const filePath = this.resolveDescriptionFilePath(requestedPath);
            if (!fs.existsSync(filePath)) {
                return {
                    isError: true,
                    content: [{
                        type: 'text' as const,
                        text: `Description file not found: ${requestedPath} (resolved to ${filePath})`,
                    }],
                };
            }

            const content = fs.readFileSync(filePath, 'utf-8');
            const updatedContent = this.insertInstance(content, instanceOml);
            fs.writeFileSync(filePath, updatedContent, 'utf-8');

            return {
                content: [{
                    type: 'text' as const,
                    text:
                        `✓ Added ${shape.targetClass} instance "${params.name}" to ${this.displayPath(filePath)}\n` +
                        `  requested path: ${requestedPath}\n\n` +
                        `${instanceOml}\n\n✓ File updated successfully`,
                }],
            };
        };
    }

    createUpdateHandler(shape: ShapeDefinition) {
        return async (params: Record<string, any>) => {
            const requestedPath = String(params.descriptionFile ?? '');
            const filePath = this.resolveDescriptionFilePath(requestedPath);
            if (!fs.existsSync(filePath)) {
                return {
                    isError: true,
                    content: [{ type: 'text' as const, text: `Description file not found: ${requestedPath} (resolved to ${filePath})` }],
                };
            }

            const content = fs.readFileSync(filePath, 'utf-8');
            const instanceName = params.instanceName;

            // Find the instance block: instance NAME : ... [ ... ]
            const instanceRegex = new RegExp(
                `(\\s*instance\\s+${this.escapeRegex(instanceName)}\\s*:[^\\[]*\\[)([^\\]]*)(\\])`,
                's',
            );
            const match = content.match(instanceRegex);
            if (!match) {
                return {
                    isError: true,
                    content: [{ type: 'text' as const, text: `Instance "${instanceName}" not found in ${filePath}` }],
                };
            }

            // Rebuild the property block with updated values
            let propertyBlock = match[2];
            for (const prop of shape.properties) {
                const paramName = this.getParamName(prop.path);
                const newValue = params[paramName];
                if (newValue === undefined || newValue === null) continue;

                const formattedValue = this.formatValue(newValue, prop);
                const propRegex = new RegExp(`(\\s*${this.escapeRegex(prop.path)}\\s+)([^\\n]+)`);
                if (propRegex.test(propertyBlock)) {
                    propertyBlock = propertyBlock.replace(propRegex, `$1${formattedValue}`);
                } else {
                    // Add new property
                    propertyBlock += `\n        ${prop.path} ${formattedValue}`;
                }
            }

            const updatedContent = content.replace(instanceRegex, `${match[1]}${propertyBlock}${match[3]}`);
            fs.writeFileSync(filePath, updatedContent, 'utf-8');

            return {
                content: [{
                    type: 'text' as const,
                    text:
                        `✓ Updated ${shape.targetClass} instance "${instanceName}" in ${this.displayPath(filePath)}\n` +
                        `  requested path: ${requestedPath}`,
                }],
            };
        };
    }

    createDeleteHandler(shape: ShapeDefinition) {
        return async (params: Record<string, any>) => {
            const requestedPath = String(params.descriptionFile ?? '');
            const filePath = this.resolveDescriptionFilePath(requestedPath);
            if (!fs.existsSync(filePath)) {
                return {
                    isError: true,
                    content: [{ type: 'text' as const, text: `Description file not found: ${requestedPath} (resolved to ${filePath})` }],
                };
            }

            const content = fs.readFileSync(filePath, 'utf-8');
            const instanceName = params.instanceName;

            // Match the full instance block including surrounding whitespace
            const instanceRegex = new RegExp(
                `\\n?\\s*instance\\s+${this.escapeRegex(instanceName)}\\s*:[^\\[]*\\[[^\\]]*\\]`,
                's',
            );
            if (!instanceRegex.test(content)) {
                return {
                    isError: true,
                    content: [{ type: 'text' as const, text: `Instance "${instanceName}" not found in ${filePath}` }],
                };
            }

            const updatedContent = content.replace(instanceRegex, '');
            fs.writeFileSync(filePath, updatedContent, 'utf-8');

            return {
                content: [{
                    type: 'text' as const,
                    text:
                        `✓ Deleted ${shape.targetClass} instance "${instanceName}" from ${this.displayPath(filePath)}\n` +
                        `  requested path: ${requestedPath}`,
                }],
            };
        };
    }

    createGetHandler(shape: ShapeDefinition) {
        return async (params: Record<string, any>) => {
            const requestedPath = String(params.descriptionFile ?? '');
            const filePath = this.resolveDescriptionFilePath(requestedPath);
            if (!fs.existsSync(filePath)) {
                return {
                    isError: true,
                    content: [{ type: 'text' as const, text: `Description file not found: ${requestedPath} (resolved to ${filePath})` }],
                };
            }

            const content = fs.readFileSync(filePath, 'utf-8');
            const instanceName = params.instanceName;

            const instanceRegex = new RegExp(
                `(\\s*instance\\s+${this.escapeRegex(instanceName)}\\s*:[^\\[]*\\[[^\\]]*\\])`,
                's',
            );
            const match = content.match(instanceRegex);
            if (!match) {
                return {
                    isError: true,
                    content: [{ type: 'text' as const, text: `Instance "${instanceName}" not found in ${filePath}` }],
                };
            }

            return {
                content: [{
                    type: 'text' as const,
                    text: match[1].trim(),
                }],
            };
        };
    }

    private insertInstance(fileContent: string, instanceOml: string): string {
        const lastBrace = fileContent.lastIndexOf('}');
        if (lastBrace === -1) {
            return fileContent + '\n' + instanceOml + '\n';
        }

        return (
            fileContent.substring(0, lastBrace) +
            '\n' + instanceOml + '\n' +
            fileContent.substring(lastBrace)
        );
    }

    private getParamName(path: string): string {
        const parts = path.split(':');
        return parts.length > 1 ? parts[1] : path;
    }

    private formatValue(value: any, prop: PropertyConstraint): string {
        if (prop.class) {
            return String(value);
        }
        if (prop.datatype && prop.datatype.includes('string')) {
            return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
        }
        return String(value);
    }

    private escapeRegex(str: string): string {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    private resolveDescriptionFilePath(filePath: string): string {
        return resolveWorkspacePath(filePath);
    }

    private displayPath(filePath: string): string {
        return getRelativeWorkspacePath(filePath);
    }
}
