import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import { URI } from 'langium';
import { NodeFileSystem } from 'langium/node';
import { createOmlServices } from '../../../oml-module.js';
import {
    isDescription,
    Annotation,
    Description,
} from '../../../generated/ast.js';
import { resolveWorkspacePath } from '../common.js';
import {
    validateWithShacl,
    type ShaclValidationResult,
} from './core/index.js';
import { createLogger } from '../common/logger.js';
import { handleError, DescriptionParseError } from '../common/error-handler.js';
import {
    parseDescriptionAst,
    type PropertyAssertion,
    type InstanceInfo,
    type ImportPrefixMap,
} from '../parsing/index.js';

export const enforceMethodologyRulesTool = {
    name: 'enforce_methodology_rules' as const,
    description: `Validate OML description files against SHACL shapes.

USE THIS TOOL when the user asks:
- "Check my OML file for methodology issues"
- "Validate this description against SHACL"
- "Check whether this description conforms to shapes"

MINIMAL CALL (auto-discovers shapes):
{
  "descriptionPath": "/path/to/description_file.oml"
}

EXPLICIT SHAPES PATH:
{
  "descriptionPath": "/path/to/description_file.oml",
  "shapesPath": "/path/to/methodology-shapes.ttl"
}

RETURNS:
- SHACL violations with focus node/path/severity details
- Formatted markdown report`,
    paramsSchema: {
        descriptionPath: z.string().optional().describe('Path to OML description file to validate'),
        descriptionCode: z.string().optional().describe('Raw OML code to validate (instead of file)'),
        shapesPath: z.string().optional().describe('Path to SHACL shapes graph (.ttl/.nq/.nt/.trig). Optional if discoverable from description annotation or shapes folder convention.'),
    },
};

export const enforceMethodologyRulesMetadata = {
    id: 'enforce_methodology_rules',
    displayName: 'Enforce Methodology Rules',
    layer: 'methodology' as const,
    severity: 'critical' as const,
    version: '2.0.0',
    shortDescription: 'Validate description files against SHACL shapes',
    description: 'Validates OML description files for compliance with SHACL-based methodology constraints.',
    tags: ['validation', 'methodology', 'shacl', 'enforcement'],
    dependencies: [],
    addedDate: '2024-01-01',
};

async function parseDescription(descriptionPath?: string, descriptionCode?: string): Promise<{
    assertions: PropertyAssertion[];
    instances: InstanceInfo[];
    sourceCode: string;
    importPrefixMap: ImportPrefixMap;
    importNamespaceMap: Record<string, string>;
    resolvedDescriptionPath?: string;
    shaclShapesHint?: string;
}> {
    const logger = createLogger('parseDescription');
    logger.debug(`Starting parse`, { descriptionPath, hasCode: !!descriptionCode });

    const services = createOmlServices(NodeFileSystem).Oml;

    let content: string;
    let uri: URI;
    let resolvedDescriptionPath: string | undefined;

    if (descriptionPath) {
        const resolvedPath = path.isAbsolute(descriptionPath)
            ? descriptionPath
            : resolveWorkspacePath(descriptionPath);
        resolvedDescriptionPath = resolvedPath;

        if (!fs.existsSync(resolvedPath)) {
            throw new DescriptionParseError(resolvedPath, new Error('File not found'));
        }

        content = fs.readFileSync(resolvedPath, 'utf-8');
        uri = URI.file(resolvedPath);
        logger.debug(`Loaded description file`, { path: resolvedPath, size: content.length });
    } else if (descriptionCode) {
        content = descriptionCode;
        uri = URI.parse('memory://temp-description.oml');
        logger.debug(`Using inline code`, { size: content.length });
    } else {
        throw new Error('Either descriptionPath or descriptionCode must be provided');
    }

    const langiumDocs = services.shared.workspace.LangiumDocuments;
    const tempDoc = services.shared.workspace.LangiumDocumentFactory.fromString(content, uri);
    const tempRoot = tempDoc.parseResult.value;

    if (!isDescription(tempRoot)) {
        throw new DescriptionParseError(descriptionPath || 'inline', new Error('Not a valid OML description'));
    }

    const description = tempRoot as Description;

    const getAnnotationPropertyName = (annotation: Annotation): string | undefined => {
        if (annotation.property?.ref?.name) {
            const ref = annotation.property.ref;
            const containerPrefix = (ref.$container as { prefix?: string } | undefined)?.prefix;
            return containerPrefix ? `${containerPrefix}:${ref.name}` : ref.name;
        }
        return annotation.property?.$refText;
    };

    const stripQuotedLiteral = (value: string): string => {
        if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
        ) {
            return value.slice(1, -1);
        }
        return value;
    };

    const getAnnotationTextValues = (annotation: Annotation): string[] => {
        const literalValues = (annotation.literalValues || [])
            .map((literal) => {
                const raw = (literal as { value?: unknown }).value;
                return raw === undefined || raw === null ? undefined : stripQuotedLiteral(String(raw)).trim();
            })
            .filter((value): value is string => !!value);

        const referencedValues = (annotation.referencedValues || [])
            .map((reference) => reference.ref?.name || reference.$refText)
            .filter((value): value is string => !!value)
            .map((value) => value.trim());

        return [...literalValues, ...referencedValues];
    };

    const detectShapesHintFromAnnotations = (astDescription: Description): string | undefined => {
        const shapeKeyNames = new Set(['shaclshapes', 'shapespath', 'shaclshape', 'shape']);
        const dcShapePropertyNames = new Set(['relation', 'source', 'references']);
        const looksLikeShapePath = (value: string): boolean => {
            const trimmed = value.trim();
            return /\.(ttl|nt|nq|trig)$/i.test(trimmed) || /(^|[\\/])shapes([\\/]|$)/i.test(trimmed);
        };

        for (const annotation of astDescription.ownedAnnotations || []) {
            const propertyName = getAnnotationPropertyName(annotation);
            if (!propertyName) {
                continue;
            }

            const prefix = propertyName.includes(':')
                ? propertyName.substring(0, propertyName.indexOf(':'))
                : undefined;
            const localName = propertyName.includes(':')
                ? propertyName.substring(propertyName.lastIndexOf(':') + 1)
                : propertyName;
            const localNameLower = localName.toLowerCase();
            const prefixLower = prefix?.toLowerCase();

            const isNamedShapeProperty = shapeKeyNames.has(localNameLower);
            const isDcShapeProperty = prefixLower === 'dc' && dcShapePropertyNames.has(localNameLower);

            if (!isNamedShapeProperty && !isDcShapeProperty) {
                continue;
            }

            const values = getAnnotationTextValues(annotation);
            if (values.length > 0) {
                return values.find(looksLikeShapePath) || values[0];
            }
        }

        return undefined;
    };

    const importNamespaceMap: Record<string, string> = {};
    for (const imp of description.ownedImports || []) {
        const namespaceRef = imp.imported?.$refText;
        if (!imp.prefix || !namespaceRef) {
            continue;
        }
        const namespace = namespaceRef.trim().replace(/^</, '').replace(/>$/, '');
        importNamespaceMap[imp.prefix] = namespace;
    }

    const document = await langiumDocs.getOrCreateDocument(uri);
    await services.shared.workspace.DocumentBuilder.build([document], { validation: false });

    const parsed = parseDescriptionAst(description, content, logger);
    const shaclShapesHint = detectShapesHintFromAnnotations(description);
    logger.info(`Parse complete`, { assertions: parsed.assertions.length, instances: parsed.instances.length });

    return {
        ...parsed,
        importNamespaceMap,
        resolvedDescriptionPath,
        shaclShapesHint,
    };
}

function formatShaclResult(
    result: ShaclValidationResult,
    shapesPath: string,
): string {
    const lines: string[] = [];
    lines.push(`# SHACL Methodology Enforcement`);
    lines.push('');
    lines.push(`**Shapes:** ${shapesPath}`);
    lines.push('');

    if (result.conforms) {
        lines.push(`✅ **Description conforms to all SHACL shapes.**`);
        return lines.join('\n');
    }

    lines.push(`⚠️ **Found ${result.violations.length} SHACL violation(s)**`);
    lines.push('');

    for (const [index, violation] of result.violations.entries()) {
        lines.push(`## Violation ${index + 1}`);
        lines.push(`- **Message:** ${violation.message}`);
        if (violation.focusNode) lines.push(`- **Focus node:** ${violation.focusNode}`);
        if (violation.path) lines.push(`- **Path:** ${violation.path}`);
        if (violation.severity) lines.push(`- **Severity:** ${violation.severity}`);
        if (violation.sourceShape) lines.push(`- **Shape:** ${violation.sourceShape}`);
        if (violation.sourceConstraintComponent) {
            lines.push(`- **Constraint component:** ${violation.sourceConstraintComponent}`);
        }
        if (violation.line !== undefined) lines.push(`- **Line:** ${violation.line}`);
        lines.push('');
    }

    return lines.join('\n');
}

function resolveShaclShapesPath(params: {
    explicitShapesPath?: string;
    descriptionPath?: string;
    annotationShapesPath?: string;
}): string | null {
    const tryResolveCandidate = (candidate: string, descriptionPath?: string): string | null => {
        const trimmed = candidate.trim();
        if (!trimmed) {
            return null;
        }

        if (path.isAbsolute(trimmed) && fs.existsSync(trimmed)) {
            return trimmed;
        }

        const workspaceResolved = resolveWorkspacePath(trimmed);
        if (fs.existsSync(workspaceResolved)) {
            return workspaceResolved;
        }

        if (descriptionPath) {
            const fromDescriptionDir = path.resolve(path.dirname(descriptionPath), trimmed);
            if (fs.existsSync(fromDescriptionDir)) {
                return fromDescriptionDir;
            }
        }

        return null;
    };

    if (params.explicitShapesPath) {
        const resolved = tryResolveCandidate(params.explicitShapesPath, params.descriptionPath);
        if (resolved) {
            return resolved;
        }
    }

    if (params.annotationShapesPath) {
        const resolved = tryResolveCandidate(params.annotationShapesPath, params.descriptionPath);
        if (resolved) {
            return resolved;
        }
    }

    if (!params.descriptionPath) {
        return null;
    }

    const descriptionBaseName = path.basename(params.descriptionPath, path.extname(params.descriptionPath));
    const descriptionDir = path.dirname(params.descriptionPath);
    const extensions = ['.ttl', '.nt', '.nq', '.trig'];
    const workspaceShapesDir = resolveWorkspacePath('shapes');

    const candidatePaths: string[] = [];
    for (const extension of extensions) {
        candidatePaths.push(path.join(descriptionDir, 'shapes', `${descriptionBaseName}${extension}`));
        candidatePaths.push(path.join(descriptionDir, 'shapes', `${descriptionBaseName}-shapes${extension}`));
        candidatePaths.push(path.join(descriptionDir, 'shapes', `${descriptionBaseName}.shapes${extension}`));
        candidatePaths.push(path.join(workspaceShapesDir, `${descriptionBaseName}${extension}`));
        candidatePaths.push(path.join(workspaceShapesDir, `${descriptionBaseName}-shapes${extension}`));
        candidatePaths.push(path.join(workspaceShapesDir, `${descriptionBaseName}.shapes${extension}`));
    }

    return candidatePaths.find((candidatePath) => fs.existsSync(candidatePath)) || null;
}

export const enforceMethodologyRulesHandler = async (params: {
    descriptionPath?: string;
    descriptionCode?: string;
    shapesPath?: string;
}): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> => {
    const logger = createLogger('enforceMethodologyRulesHandler');

    try {
        logger.info(`Starting SHACL methodology enforcement`, {
            hasDescription: !!params.descriptionPath || !!params.descriptionCode,
            hasShapesPath: !!params.shapesPath,
        });

        const { descriptionPath, descriptionCode } = params;

        if (!descriptionPath && !descriptionCode) {
            throw new Error('Either descriptionPath or descriptionCode must be provided');
        }

        logger.debug(`Parsing description`, { path: descriptionPath, hasCode: !!descriptionCode });
        const {
            assertions,
            instances,
            importNamespaceMap,
            resolvedDescriptionPath,
            shaclShapesHint,
        } = await parseDescription(descriptionPath, descriptionCode);

        logger.info(`Description parsed`, { assertions: assertions.length, instances: instances.length });

        const effectiveDescriptionPath = resolvedDescriptionPath || (descriptionPath ? resolveWorkspacePath(descriptionPath) : undefined);
        const resolvedShapesPath = resolveShaclShapesPath({
            explicitShapesPath: params.shapesPath,
            descriptionPath: effectiveDescriptionPath,
            annotationShapesPath: shaclShapesHint,
        });

        if (!resolvedShapesPath) {
            throw new Error(
                'Could not resolve SHACL shapes file. Provide shapesPath, annotate the description with a shape pointer (e.g., dc:relation "shapes/my-description.ttl"), or add a matching file under shapes/.',
            );
        }

        const shaclResult = await validateWithShacl({
            assertions,
            instances,
            shapesPath: resolvedShapesPath,
            namespaceIriMap: importNamespaceMap,
        });

        const formatted = formatShaclResult(shaclResult, resolvedShapesPath);
        return {
            content: [{ type: 'text', text: formatted }],
        };
    } catch (error) {
        logger.error(`Tool execution failed`, error as Error);
        return handleError(error, 'enforce_methodology_rules', logger);
    }
};
