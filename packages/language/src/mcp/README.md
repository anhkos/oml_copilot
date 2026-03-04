# OML MCP Server

A Model Context Protocol (MCP) server that provides tools for creating, modifying, and managing OML (Ontological Modeling Language) ontologies programmatically.

## What is the OML MCP Server?

The OML MCP Server is an AI-native tool that bridges OML ontologies and AI assistants through the Model Context Protocol standard. It enables:

- **Programmatic Ontology Manipulation**: Create, read, update, and delete OML ontology components (concepts, relations, instances, etc.)
- **Intelligent Symbol Resolution**: Automatically resolve cross-references and manage imports across your workspace
- **Methodology Enforcement**: Define and enforce modeling conventions across your entire ontology
- **Semantic Validation**: Validate OML syntax, semantics, and consistency rules
- **AI-Driven Development**: Work with AI assistants to design and evolve your ontologies interactively

### Key Capabilities

- **Specialized tools** for ontology engineering workflows
- **Bidirectional relation handling** with direction preferences
- **Methodology SHACL shapes** for consistent modeling patterns (e.g., Sierra methodology)
- **Automatic import management** and symbol resolution across workspaces
- **Comprehensive error handling** with remediation suggestions

## Setup Instructions

### Prerequisites

- Node.js 18+ (or compatible runtime)
- OML language package built (`npm run build` in the root workspace)
- An OML workspace with vocabulary and/or description files

### Installation

1. **Build the entire OML workspace** (if not already built):
```bash
cd c:\Users\sokhn\OneDrive\Documents\GitHub\oml-code
npm run build
```

2. **Start the MCP server** in one of two ways:

**Option A: Direct execution** (for development/testing)
```bash
node packages/language/src/mcp/server.js
```

**Option B: Via compiled output** (after building)
```bash
npm run build
node out/language/src/mcp/server.js
```

3. **Configure your MCP client** to connect to the server over stdio

### Environment Setup

The server respects the following environment variables:

- `OML_WORKSPACE_ROOT` - Set the root directory for your OML workspace
  ```bash
  set OML_WORKSPACE_ROOT=c:\Users\sokhn\OneDrive\Documents\GitHub\sierra-method
  node packages/language/src/mcp/server.js
  ```

If not set, the server uses the current working directory.

### Testing the Server

Once running, you can test the server by calling a simple tool through your MCP client. For instance, with an OML file open, you can ask GitHub Copilot: "Can you validate my OML code with MCP tools?"

```json
{
  "tool": "validate_oml",
  "params": {
    "uri": "path/to/your/file.oml"
  }
}
```

Expected response: Validation results with any syntax/semantic errors found.

## Getting MCP Clients to Use the Tools

### The Challenge

MCP clients (like GitHub Copilot) have powerful tools available, but nudging them to use the tools can be a bit tricky. AI assistants are designed to be helpful and can solve many problems through reasoning alone, so without proper guidance, they may not reach for MCP tools even when they would be most effective.

### Best Practices

**Use explicit instructions in your prompts:**
- "Use the OML MCP tools" (usually works best, can state this at the beginning of a chat)
- "Call the enforce_methodology_rules tool to check this against SHACL shapes"
- "Use create_concept_instance to add this to the ontology"

**Set context in your system prompt / Copilot instructions:**
- List which tools are available and their purposes
- Give examples of when each tool should be used
- Explain that tools should be used for code generation and validation

**Provide tool hints in user messages:**
- "I need to validate this OML file. Can you use the validate oml tool?"
- "Create a new concept using the create_concept tool"

### Coming Soon: Complete Guide

I will write a comprehensive guide on prompting strategies and Copilot instructions soon. In the meantime, experiment with explicit tool requests and observe which prompts get the best results.

## Overview

## Configuration

### Workflow Modes (Dynamic Tool Exposure)

The server supports workflow modes to reduce tool overload and keep prompts focused:

- **`basic` (default):** core OML modeling tools (terms, axioms, instances, ontology, rules, validation/query)
- **`methodology`:** enables methodology-aware workflows (SHACL validation/enforcement + shape-driven coding)

Set mode with `set_preferences`:

```json
{
  "tool": "set_preferences",
  "params": {
    "workflowMode": "basic"
  }
}
```

Enable methodology mode when you are explicitly editing methodology/shape assets:

```json
{
  "tool": "set_preferences",
  "params": {
    "workflowMode": "methodology"
  }
}
```

Note: when switching to `workflowMode: "methodology"`, `strictMethodologyRouting` is auto-enabled by default (unless you explicitly set it). This helps smaller models route edits through `route_shape_intent` instead of direct mutation tools.

Legacy note: `workflowMode: "methodology_coding"` is accepted as a backward-compatible alias and normalized to `"methodology"`.

For smaller models, enable strict routing so methodology edits always go through the shape router:

```json
{
  "tool": "set_preferences",
  "params": {
    "workflowMode": "methodology",
    "strictMethodologyRouting": true
  }
}
```

When strict routing is enabled, direct mutation tools (like `create_concept`, `create_concept_instance`, `update_instance`) are blocked in methodology mode and the model is guided to use `route_shape_intent`.

If a gated tool is called while in the wrong mode, the server returns a clear message listing allowed modes and a suggested `set_preferences` call.

## Tool Categories

### Validation and Query Tools

| Tool | Description |
|------|-------------|
| `validate_oml` | Validates OML code for syntax and semantic errors |
| `suggest_oml_symbols` | Searches for available OML symbols in the workspace |
| `analyze_impact` | Previews the impact of deleting a symbol across the workspace |

### Term Creation Tools

Tools for creating vocabulary terms (concepts, aspects, relations, properties).

| Tool | Description |
|------|-------------|
| `create_aspect` | Creates an aspect in a vocabulary |
| `create_concept` | Creates a concept with optional keys and instance enumeration |
| `create_relation_entity` | Creates a relation entity with source/target types |
| `create_relation` | Creates an unreified relation |
| `create_scalar` | Creates a scalar type with optional literal enumeration |
| `create_scalar_property` | Creates a scalar property with domain and range |
| `create_annotation_property` | Creates an annotation property |
| `delete_term` | Deletes a term from a vocabulary |
| `update_term` | Updates/renames a term |

### Axiom Tools

Tools for managing specializations, restrictions, equivalences, and annotations.

| Tool | Description |
|------|-------------|
| `add_specialization` | Adds super terms to a term's specialization clause |
| `delete_specialization` | Removes a super term from specialization |
| `add_restriction` | Adds a property restriction to an entity |
| `update_restriction` | Updates an existing restriction |
| `delete_restriction` | Removes a restriction |
| `add_equivalence` | Adds an equivalence axiom to a term |
| `update_equivalence` | Updates an equivalence axiom |
| `delete_equivalence` | Removes an equivalence axiom |
| `update_annotation` | Updates annotations on a term |
| `delete_annotation` | Removes an annotation |
| `update_key` | Updates key axioms on an entity |
| `delete_key` | Removes a key axiom |

### Instance Tools

Tools for managing instances in description ontologies.

| Tool | Description |
|------|-------------|
| `create_concept_instance` | Creates a concept instance with types and properties |
| `create_relation_instance` | Creates a relation instance with sources/targets |
| `update_instance` | Updates an instance (name, types, properties) |
| `delete_instance` | Deletes an instance |
| `update_property_value` | Updates property values on an instance |
| `delete_property_value` | Removes a property value |
| `delete_type_assertion` | Removes a type assertion from an instance |

### Ontology Management Tools

Tools for creating and managing ontology files.

| Tool | Description |
|------|-------------|
| `create_ontology` | Creates a new vocabulary, bundle, or description |
| `add_import` | Adds an import statement to an ontology |
| `delete_import` | Removes an import statement |
| `delete_ontology` | Deletes an ontology file |

### Rule Tools

Tools for managing SWRL-style rules.

| Tool | Description |
|------|-------------|
| `create_rule` | Creates a rule with antecedents and consequents |
| `update_rule` | Updates an existing rule |
| `delete_rule` | Deletes a rule |

### Methodology Tools

SHACL enforcement tool for methodology workflows.

> These are gated by workflow mode and require `workflowMode: "methodology"`.

**Current scope:** methodology mode exposes SHACL enforcement and shape-driven intent routing.

| Tool | Description |
|------|-------------|
| `enforce_methodology_rules` | Validates descriptions against SHACL shapes |
| `route_shape_intent` | Routes natural-language intents (e.g., "add stakeholder") to shape-driven generic modeling plans; execution is optional |


#### SHACL Methodology Enforcement

Use SHACL shapes as the single source of methodology constraints.

**Recommended workflow:**

1. Create or maintain shape files per description (or shared shape sets).
2. Point a description to a shape file with an annotation (for example `dc:relation "shapes/system-description.ttl"`) or pass `shapesPath` explicitly.
3. Run `enforce_methodology_rules` to validate and review violations.

**SHACL Starter Template:**
- **Understandability**: Teams know exactly which direction to use for each relation
- **Automation**: AI assistants can automatically enforce rules and suggest corrections
- **Evolution**: As methodology evolves, update shapes and re-validate all descriptions
- **Documentation**: Shapes serve as executable methodology documentation

**Technical Details:**

The SHACL system works by:
1. Converting description assertions into RDF triples
2. Loading shapes from explicit path, annotation, or shape-file conventions
3. Validating the RDF graph against SHACL Core constraints
4. Reporting violations with focus node, path, and best-effort source mapping

**SHACL Starter Template:**

- Starter shapes file: [packages/language/src/mcp/tools/methodology/examples/methodology-shapes.template.ttl](packages/language/src/mcp/tools/methodology/examples/methodology-shapes.template.ttl)
- Copy it into your methodology workspace, replace namespace IRIs, and add one `sh:NodeShape` per concept whose relation direction you want to enforce.
- Direction enforcement pattern: keep preferred property shape, add opposite property shape with `sh:maxCount 0`.

**Per-description SHACL file structure (recommended):**

- Keep SHACL files in a dedicated `shapes/` folder.
- Name shapes by description file base name, e.g. `system-description.oml` → `shapes/system-description.ttl` (also supports `-shapes.ttl` and `.shapes.ttl`).
- Optionally annotate the description to point to a shape path explicitly.

Example description annotation (Dublin Core):

```oml
@dc:relation "shapes/system-description.ttl"
description <https://example.com/system-description#> as systemDesc uses <http://purl.org/dc/elements/1.1/> as dc {
  ...
}
```

Supported annotation property local names are: `shaclShapes`, `shapesPath`, `shaclShape`, `shape`.
For Dublin Core annotations, `dc:relation`, `dc:source`, and `dc:references` are also recognized.

**Run SHACL enforcement:**

```json
{
  "tool": "enforce_methodology_rules",
  "params": {
    "shapesPath": "sierra/methodology-shapes.ttl",
    "descriptionPath": "sierra/system-description.oml"
  }
}
```

Note: the integrated validator supports SHACL Core constraints; SHACL-SPARQL constraints are not supported.

See the methodology tools section in [IDEAS.md](./IDEAS.md) for implementation notes.

### Preference Tools

Tools for managing user preferences and feedback.

| Tool | Description |
|------|-------------|
| `get_preferences` | Retrieves current user preferences |
| `set_preferences` | Sets user preferences |
| `log_feedback` | Logs feedback on tool executions |

## Key Concepts

### Vocabularies vs Descriptions

- **Vocabulary**: Defines terms (concepts, aspects, relations, properties). Use for schema/ontology definitions.
- **Description**: Contains instances of vocabulary terms. Use for data/assertions.
- **Bundle**: Aggregates multiple ontologies.

### Symbol Resolution

The server automatically resolves symbols across the workspace. When you reference a type like `requirement:Stakeholder`, the server:

1. Searches all loaded ontologies for the symbol
2. Verifies the symbol exists and is the correct type
3. Returns helpful errors if the symbol is not found

### Import Management

Many tools automatically handle imports. When you reference a symbol from another ontology, the server can add the required import statement.

### Type Assertions vs Properties

In OML, instance types are declared in the instance header, not as properties:

```oml
// Correct - types in declaration
instance MyInstance : Type1, Type2 [
    property value
]

// Wrong - rdf:type is not a property in OML
instance MyInstance [
    rdf:type Type1  // This does not work
]
```

To add types to an existing instance, use `update_instance` with `newTypes`.

## Error Handling

The server provides detailed error messages with guidance:

- **Instance already exists**: Redirects to `update_instance`
- **Wrong property (rdf:type)**: Explains OML type system and redirects to `update_instance`
- **Ontology not found**: Suggests creating the ontology first
- **Wrong ontology type**: Explains vocabulary vs description distinction
- **Symbol not found**: Lists similar symbols that exist in the workspace

## Architecture

```
mcp/
  server.ts           # Main MCP server entry point
  tools/
    index.ts          # Tool registration and exports
    common.ts         # Shared utilities (workspace, documents)
    description-common.ts  # Description-specific utilities
    schemas.ts        # Zod schemas for parameters
    types.ts          # TypeScript type definitions
    validate-tool.ts  # OML validation tool
    
    terms/            # Term creation tools
    axioms/           # Axiom management tools
    instances/        # Instance tools
    ontology/         # Ontology management tools
    rules/            # Rule tools
    query/            # Query and search tools
    methodology/      # High-level workflow tools
    preferences/      # User preference tools
    stubs/            # Placeholder tools (pending implementation)
```

## Development

### Building

```bash
npm run build
```

### Testing

The server integrates with the OML language server for parsing and validation. Ensure the language package is built before running the MCP server.

### Adding New Tools

1. Create a tool file in the appropriate category folder
2. Export `toolName` (tool definition) and `toolNameHandler` (implementation)
3. Add to the category's `index.ts`
4. The tool will automatically be registered with the MCP server

Tool definition structure:

```typescript
import { z } from 'zod';

const paramsSchema = {
    param1: z.string().describe('Description of param1'),
    param2: z.number().optional().describe('Optional param2'),
};

export const myTool = {
    name: 'my_tool' as const,
    description: 'What the tool does and when to use it',
    paramsSchema,
};

export const myToolHandler = async (params: { param1: string; param2?: number }) => {
    // Implementation
    return {
        content: [{ type: 'text' as const, text: 'Result message' }],
    };
};
```
