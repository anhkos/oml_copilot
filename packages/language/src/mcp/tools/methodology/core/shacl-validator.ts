import * as path from 'path';
import rdf from '@zazuko/env-node';
import SHACLValidator from 'rdf-validate-shacl';
import { resolveWorkspacePath } from '../../common.js';
import { type InstanceInfo, type PropertyAssertion } from '../../parsing/index.js';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

export interface ShaclViolation {
    message: string;
    path?: string;
    focusNode?: string;
    severity?: string;
    sourceShape?: string;
    sourceConstraintComponent?: string;
    line?: number;
}

export interface ShaclValidationResult {
    conforms: boolean;
    violations: ShaclViolation[];
}

export interface ValidateWithShaclParams {
    assertions: PropertyAssertion[];
    instances: InstanceInfo[];
    shapesPath: string;
    namespaceIriMap?: Record<string, string>;
    maxErrors?: number;
}

function normalizeNamespaceIri(namespaceIri: string): string {
    const trimmed = namespaceIri.trim();
    const withoutBrackets = trimmed.startsWith('<') && trimmed.endsWith('>')
        ? trimmed.slice(1, -1)
        : trimmed;
    if (withoutBrackets.endsWith('#') || withoutBrackets.endsWith('/')) {
        return withoutBrackets;
    }
    return `${withoutBrackets}#`;
}

function encodeSegment(value: string): string {
    return encodeURIComponent(value.trim());
}

function qNameToIri(
    value: string,
    kind: 'type' | 'property',
    namespaceIriMap: Record<string, string>,
): string {
    const colon = value.indexOf(':');
    if (colon > 0) {
        const prefix = value.substring(0, colon);
        const localName = value.substring(colon + 1);
        const namespace = namespaceIriMap[prefix] || `urn:oml:${kind}:${encodeSegment(prefix)}#`;
        return `${namespace}${encodeSegment(localName)}`;
    }

    return `urn:oml:${kind}:unqualified#${encodeSegment(value)}`;
}

function instanceToIri(instanceName: string): string {
    return `urn:oml:instance:${encodeSegment(instanceName)}`;
}

function buildNamespaceMap(overrides?: Record<string, string>): Record<string, string> {
    const defaults: Record<string, string> = {
        rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
        rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
        sh: 'http://www.w3.org/ns/shacl#',
        xsd: 'http://www.w3.org/2001/XMLSchema#',
    };

    const merged = { ...defaults };
    for (const [prefix, namespace] of Object.entries(overrides || {})) {
        merged[prefix] = normalizeNamespaceIri(namespace);
    }
    return merged;
}

function findBestLineForViolation(
    violation: { focusNode?: string; path?: string },
    assertions: PropertyAssertion[],
): number | undefined {
    if (!violation.focusNode || !violation.path) {
        return undefined;
    }

    const instancePrefix = 'urn:oml:instance:';
    const propertyPrefix = 'urn:oml:property:';
    if (!violation.focusNode.startsWith(instancePrefix) || !violation.path.startsWith(propertyPrefix)) {
        return undefined;
    }

    const instanceName = decodeURIComponent(violation.focusNode.slice(instancePrefix.length));
    const encodedProperty = violation.path.slice(propertyPrefix.length);
    const propertyName = decodeURIComponent(encodedProperty).replace(/%3A/g, ':');

    const match = assertions.find((assertion) =>
        assertion.instanceName === instanceName && assertion.propertyName === propertyName,
    );

    return match?.line;
}

function termToString(value: unknown): string {
    if (typeof value === 'string') {
        return value;
    }

    if (value && typeof value === 'object' && 'value' in (value as Record<string, unknown>)) {
        const termValue = (value as { value?: unknown }).value;
        if (typeof termValue === 'string') {
            return termValue;
        }
    }

    return String(value);
}

function buildDataDataset(
    assertions: PropertyAssertion[],
    instances: InstanceInfo[],
    namespaceIriMap: Record<string, string>,
) {
    const dataset = rdf.dataset();
    const knownInstances = new Set(instances.map((instance) => instance.name));

    for (const instance of instances) {
        const subject = rdf.namedNode(instanceToIri(instance.name));

        for (const instanceType of instance.types) {
            const typeIri = qNameToIri(instanceType, 'type', namespaceIriMap);
            dataset.add(rdf.quad(subject, rdf.namedNode(RDF_TYPE), rdf.namedNode(typeIri)));
        }
    }

    for (const assertion of assertions) {
        const subject = rdf.namedNode(instanceToIri(assertion.instanceName));
        const predicateIri = qNameToIri(assertion.propertyName, 'property', namespaceIriMap);
        const predicate = rdf.namedNode(predicateIri);

        for (const value of assertion.values) {
            const object = knownInstances.has(value)
                ? rdf.namedNode(instanceToIri(value))
                : rdf.literal(value);
            dataset.add(rdf.quad(subject, predicate, object));
        }
    }

    return dataset;
}

function toShaclViolation(
    rawResult: Record<string, unknown>,
    assertions: PropertyAssertion[],
): ShaclViolation {
    const messages = Array.isArray(rawResult.message)
        ? rawResult.message.map((entry) => termToString(entry)).join('; ')
        : termToString(rawResult.message || 'SHACL constraint violation');

    const focusNode = termToString(rawResult.focusNode || '');
    const pathValue = termToString(rawResult.path || '');
    const violation: ShaclViolation = {
        message: messages,
        focusNode: focusNode || undefined,
        path: pathValue || undefined,
        severity: rawResult.severity ? termToString(rawResult.severity) : undefined,
        sourceShape: rawResult.sourceShape ? termToString(rawResult.sourceShape) : undefined,
        sourceConstraintComponent: rawResult.sourceConstraintComponent
            ? termToString(rawResult.sourceConstraintComponent)
            : undefined,
    };

    violation.line = findBestLineForViolation(violation, assertions);
    return violation;
}

export async function validateWithShacl(params: ValidateWithShaclParams): Promise<ShaclValidationResult> {
    const resolvedShapesPath = path.isAbsolute(params.shapesPath)
        ? params.shapesPath
        : resolveWorkspacePath(params.shapesPath);

    const namespaceIriMap = buildNamespaceMap(params.namespaceIriMap);
    const shapes = await rdf.dataset().import(rdf.fromFile(resolvedShapesPath));
    const data = buildDataDataset(params.assertions, params.instances, namespaceIriMap);

    const validator = new SHACLValidator(shapes, {
        factory: rdf,
        maxErrors: params.maxErrors,
    });

    const report = await validator.validate(data);

    return {
        conforms: report.conforms,
        violations: report.results.map((result) =>
            toShaclViolation(result as unknown as Record<string, unknown>, params.assertions),
        ),
    };
}
