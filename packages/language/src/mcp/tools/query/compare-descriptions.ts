import { z } from 'zod';
import { loadDescriptionDocument } from '../description-common.js';
import { parseDescriptionAst } from '../parsing/description-parser.js';
import type { InstanceInfo, PropertyAssertion } from '../parsing/types.js';

const paramsSchema = {
    baseFile: z.string().describe('ABSOLUTE file path to the baseline .oml description'),
    targetFile: z.string().describe('ABSOLUTE file path to the modified .oml description to compare against the baseline'),
};

export const compareDescriptionsTool = {
    name: 'compare_descriptions' as const,
    description: `Compares two OML description files and reports structural differences.

Returns a diff of:
- Instances added or removed
- Type assertion changes on existing instances
- Property assertion changes (added/removed values per property)

Use this mid-task to verify your progress matches what was requested, or to confirm
that a modeling operation produced exactly the intended changes.

Example: compare_descriptions(baseFile="context-before.oml", targetFile="context-after.oml")
might show:
- Instance added: FireCommander (sierra:Stakeholder)
- Property added on FireCommander: sierra:expresses -> FireCommanderConcern`,
    paramsSchema,
};

export const compareDescriptionsMetadata = {
    id: 'compare_descriptions',
    displayName: 'Compare Descriptions',
    layer: 'query' as const,
    severity: 'medium' as const,
    version: '1.0.0',
    shortDescription: 'Diff two OML description files for structural changes',
    description: 'Compares two OML description snapshots and returns a structured diff of added/removed instances, type changes, and property assertion changes. Useful for mid-task self-correction.',
    tags: ['diff', 'comparison', 'analysis', 'feedback', 'methodology'],
    dependencies: [],
    addedDate: '2026-08-23',
};

export const compareDescriptionsHandler = async (
    { baseFile, targetFile }: { baseFile: string; targetFile: string }
) => {
    try {
        const [baseDoc, targetDoc] = await Promise.all([
            loadDescriptionDocument(baseFile),
            loadDescriptionDocument(targetFile),
        ]);

        const base = parseDescriptionAst(baseDoc.description, baseDoc.text);
        const target = parseDescriptionAst(targetDoc.description, targetDoc.text);

        const lines: string[] = [`DESCRIPTION DIFF`, `  base:   ${baseFile}`, `  target: ${targetFile}`, ''];

        // --- Instance diff ---
        const baseInstances = new Map<string, InstanceInfo>(base.instances.map((i) => [i.name, i]));
        const targetInstances = new Map<string, InstanceInfo>(target.instances.map((i) => [i.name, i]));

        const added = target.instances.filter((i) => !baseInstances.has(i.name));
        const removed = base.instances.filter((i) => !targetInstances.has(i.name));
        const common = target.instances.filter((i) => baseInstances.has(i.name));

        // Type changes on common instances
        const typeChanges: { name: string; before: string[]; after: string[] }[] = [];
        for (const inst of common) {
            const baseTypes = baseInstances.get(inst.name)!.types;
            const targetTypes = inst.types;
            const typesChanged =
                baseTypes.length !== targetTypes.length ||
                baseTypes.some((t, idx) => t !== targetTypes[idx]);
            if (typesChanged) {
                typeChanges.push({ name: inst.name, before: baseTypes, after: targetTypes });
            }
        }

        if (added.length > 0) {
            lines.push(`INSTANCES ADDED (${added.length}):`);
            for (const inst of added) {
                const types = inst.types.length > 0 ? ` [${inst.types.join(', ')}]` : '';
                lines.push(`  + ${inst.name}${types}`);
            }
            lines.push('');
        }

        if (removed.length > 0) {
            lines.push(`INSTANCES REMOVED (${removed.length}):`);
            for (const inst of removed) {
                const types = inst.types.length > 0 ? ` [${inst.types.join(', ')}]` : '';
                lines.push(`  - ${inst.name}${types}`);
            }
            lines.push('');
        }

        if (typeChanges.length > 0) {
            lines.push(`TYPE ASSERTION CHANGES (${typeChanges.length}):`);
            for (const change of typeChanges) {
                lines.push(`  ~ ${change.name}`);
                lines.push(`      before: [${change.before.join(', ')}]`);
                lines.push(`      after:  [${change.after.join(', ')}]`);
            }
            lines.push('');
        }

        // --- Property assertion diff on common instances ---
        const baseByInstance = groupAssertionsByInstance(base.assertions);
        const targetByInstance = groupAssertionsByInstance(target.assertions);
        const commonNames = new Set(common.map((i) => i.name));

        const propChangeSections: string[] = [];

        for (const name of commonNames) {
            const baseProps = baseByInstance.get(name) ?? new Map<string, string[]>();
            const targetProps = targetByInstance.get(name) ?? new Map<string, string[]>();

            const allProps = new Set([...baseProps.keys(), ...targetProps.keys()]);
            const instChanges: string[] = [];

            for (const prop of allProps) {
                const baseVals = new Set(baseProps.get(prop) ?? []);
                const targetVals = new Set(targetProps.get(prop) ?? []);

                const addedVals = [...targetVals].filter((v) => !baseVals.has(v));
                const removedVals = [...baseVals].filter((v) => !targetVals.has(v));

                for (const v of addedVals) instChanges.push(`    + ${prop} -> ${v}`);
                for (const v of removedVals) instChanges.push(`    - ${prop} -> ${v}`);
            }

            if (instChanges.length > 0) {
                propChangeSections.push(`  ${name}:`);
                propChangeSections.push(...instChanges);
            }
        }

        // Also show property assertions on newly added instances
        for (const inst of added) {
            const props = targetByInstance.get(inst.name);
            if (props && props.size > 0) {
                propChangeSections.push(`  ${inst.name} (new):`);
                for (const [prop, vals] of props) {
                    for (const v of vals) {
                        propChangeSections.push(`    + ${prop} -> ${v}`);
                    }
                }
            }
        }

        if (propChangeSections.length > 0) {
            lines.push(`PROPERTY ASSERTION CHANGES:`);
            lines.push(...propChangeSections);
            lines.push('');
        }

        if (added.length === 0 && removed.length === 0 && typeChanges.length === 0 && propChangeSections.length === 0) {
            lines.push('No structural differences found.');
        } else {
            const summary = [
                added.length > 0 ? `${added.length} instance(s) added` : null,
                removed.length > 0 ? `${removed.length} instance(s) removed` : null,
                typeChanges.length > 0 ? `${typeChanges.length} type change(s)` : null,
                propChangeSections.length > 0 ? 'property assertion changes present' : null,
            ]
                .filter(Boolean)
                .join(', ');
            lines.push(`Summary: ${summary}`);
        }

        return {
            content: [{ type: 'text' as const, text: lines.join('\n') }],
        };
    } catch (error) {
        return {
            isError: true,
            content: [
                { type: 'text' as const, text: `Error comparing descriptions: ${error instanceof Error ? error.message : String(error)}` },
            ],
        };
    }
};

function groupAssertionsByInstance(assertions: PropertyAssertion[]): Map<string, Map<string, string[]>> {
    const result = new Map<string, Map<string, string[]>>();
    for (const a of assertions) {
        if (!result.has(a.instanceName)) {
            result.set(a.instanceName, new Map());
        }
        const propMap = result.get(a.instanceName)!;
        propMap.set(a.propertyName, a.values);
    }
    return result;
}
