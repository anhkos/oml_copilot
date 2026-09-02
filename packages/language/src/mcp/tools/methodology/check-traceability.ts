import { z } from 'zod';
import { loadDescriptionDocument } from '../description-common.js';
import { parseDescriptionAst } from '../parsing/description-parser.js';
import type { ParsedDescription } from '../parsing/types.js';

const paramsSchema = {
    instanceName: z.string().describe(
        'Name of the entity to trace (e.g. "FireCommander"). Use the local name without prefix.'
    ),
    phases: z.array(
        z.object({
            name: z.string().describe('Human-readable phase label (e.g. "Context Analysis")'),
            file: z.string().describe('ABSOLUTE file path to the .oml description for this phase'),
        })
    ).min(2).describe('Ordered list of Sierra phases to trace through (at least two)'),
    traceRelation: z.string().describe(
        'Qualified relation name that links entities across phases (e.g. "sierra:isAllocatedTo"). ' +
        'The tool checks for this relation as both a subject and an object in each phase.'
    ),
};

export const checkTraceabilityTool = {
    name: 'check_traceability' as const,
    description: `Verifies that an entity is connected across Sierra methodology phases via a traceability relation.

Sierra requires a strict traceability chain: Context Analysis -> Operational Analysis -> System Analysis.
This tool walks the chain for a named entity and reports where connections exist and where they are broken.

Checks each consecutive phase pair for:
- Whether the entity appears in the phase (present / absent)
- Whether a traceRelation assertion connects the entity to the next phase

Use this after modeling a new entity to confirm its full traceability chain is intact before proceeding.

Example: check_traceability(instanceName="FireCommander", phases=[...], traceRelation="sierra:expresses")
might show:
  Context Analysis  : FireCommander present, sierra:expresses -> FireCommanderConcern [LINKED]
  Operational Analysis: FireCommanderConcern present, sierra:expresses -> ... [MISSING]`,
    paramsSchema,
};

export const checkTraceabilityMetadata = {
    id: 'check_traceability',
    displayName: 'Check Traceability Chain',
    layer: 'methodology' as const,
    severity: 'high' as const,
    version: '1.0.0',
    shortDescription: 'Verify Sierra traceability chain across phase descriptions',
    description: 'Checks whether an entity is connected across Sierra methodology phases (Context, Operational, System Analysis) via a specified traceability relation. Reports broken links and orphan instances.',
    tags: ['traceability', 'methodology', 'sierra', 'validation', 'chain'],
    dependencies: [],
    addedDate: '2026-08-23',
};

export const checkTraceabilityHandler = async (
    {
        instanceName,
        phases,
        traceRelation,
    }: {
        instanceName: string;
        phases: { name: string; file: string }[];
        traceRelation: string;
    }
) => {
    try {
        // Load and parse all phase descriptions
        const parsed: { name: string; desc: ParsedDescription }[] = [];
        for (const phase of phases) {
            const doc = await loadDescriptionDocument(phase.file);
            const desc = parseDescriptionAst(doc.description, doc.text);
            parsed.push({ name: phase.name, desc });
        }

        const lines: string[] = [
            `TRACEABILITY CHAIN: "${instanceName}"`,
            `  relation: ${traceRelation}`,
            '',
        ];

        let allLinked = true;
        // Track which names are connected forward from the current entity
        let currentNames = new Set<string>([instanceName]);

        for (let i = 0; i < parsed.length; i++) {
            const { name: phaseName, desc } = parsed[i];
            const isLast = i === parsed.length - 1;

            // Check if any of the current tracked names appear in this phase
            const presentNames = desc.instances
                .map((inst) => inst.name)
                .filter((n) => currentNames.has(n));
            const absentNames = [...currentNames].filter((n) => !presentNames.includes(n));

            if (presentNames.length === 0) {
                lines.push(`  ${phaseName}: ABSENT`);
                lines.push(`    None of [${[...currentNames].join(', ')}] found in this description.`);
                allLinked = false;

                if (!isLast) {
                    lines.push(`    Cannot trace further — chain broken here.`);
                    break;
                }
                continue;
            }

            if (absentNames.length > 0) {
                lines.push(`  ${phaseName}: PARTIAL (${presentNames.length}/${currentNames.size} present)`);
                lines.push(`    Present: ${presentNames.join(', ')}`);
                lines.push(`    Absent:  ${absentNames.join(', ')}`);
            } else {
                lines.push(`  ${phaseName}: PRESENT [${presentNames.join(', ')}]`);
            }

            if (isLast) {
                // Final phase — no forward link needed
                lines.push(`    (final phase, no forward link required)`);
                continue;
            }

            // Find forward links via traceRelation from any present name
            const linkedTargets: string[] = [];
            for (const assertion of desc.assertions) {
                const nameMatches = presentNames.includes(assertion.instanceName);
                const propMatches =
                    assertion.propertyName === traceRelation ||
                    assertion.propertyQualified === traceRelation;
                if (nameMatches && propMatches) {
                    linkedTargets.push(...assertion.values);
                }
            }

            // Also check reverse: present name appears as a value of traceRelation on another instance
            const reverseLinkedSubjects: string[] = [];
            for (const assertion of desc.assertions) {
                const propMatches =
                    assertion.propertyName === traceRelation ||
                    assertion.propertyQualified === traceRelation;
                const valueMatches = assertion.values.some((v) => presentNames.includes(v));
                if (propMatches && valueMatches) {
                    reverseLinkedSubjects.push(assertion.instanceName);
                }
            }

            const allTargets = [...new Set([...linkedTargets, ...reverseLinkedSubjects])];

            if (allTargets.length === 0) {
                lines.push(`    ${traceRelation}: MISSING — no forward link to next phase`);
                allLinked = false;
            } else {
                lines.push(`    ${traceRelation} -> ${allTargets.join(', ')} [LINKED]`);
                currentNames = new Set(allTargets);
            }
        }

        lines.push('');
        lines.push(allLinked ? 'RESULT: Traceability chain is complete.' : 'RESULT: Traceability chain has gaps (see above).');

        return {
            content: [{ type: 'text' as const, text: lines.join('\n') }],
        };
    } catch (error) {
        return {
            isError: true,
            content: [
                { type: 'text' as const, text: `Error checking traceability: ${error instanceof Error ? error.message : String(error)}` },
            ],
        };
    }
};
