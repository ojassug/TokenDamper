import type { Node } from 'web-tree-sitter';

import type { DeepRegion } from './regions';

/**
 * C and C# for the Deep backend (R4, spec §4.3–§4.4, DECISIONS §85–§86).
 *
 * **One rule decides both symbols and regions: a declaration whose body is a `{ … }` block.**
 * Regions are those blocks' interiors. Symbols are those declarations' names, and nothing else —
 * not prototypes, not abstract or interface members, not expression-bodied members, and not
 * types, which the shared regex already harvests. A symbol for a declaration elision cannot touch
 * would survive every transform by construction, raising `R_AST` and lowering `S_k` for the same
 * loss — §59's falling drift score, the hazard this package was built to avoid.
 *
 * The node tables are §82's, which passed 44 known-answer fixtures before any corpus was measured.
 */

export type CFamilyLanguage = 'c' | 'csharp';

export interface Definition {
  readonly symbol: string;
  readonly start: number;
  readonly end: number;
}

const C_FUNCTION_NODES: ReadonlySet<string> = new Set(['function_definition']);

const CSHARP_FUNCTION_NODES: ReadonlySet<string> = new Set([
  'method_declaration',
  'constructor_declaration',
  'destructor_declaration',
  'operator_declaration',
  'conversion_operator_declaration',
  'local_function_statement',
  'accessor_declaration',
  'lambda_expression',
  'anonymous_method_expression',
]);

const CSHARP_TYPE_NODES: ReadonlySet<string> = new Set([
  'class_declaration',
  'struct_declaration',
  'record_declaration',
  'interface_declaration',
]);

function walk(root: Node, visit: (node: Node) => void): void {
  const stack: Node[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    visit(node);
    for (let i = node.namedChildCount - 1; i >= 0; i--) {
      const child = node.namedChild(i);
      if (child) stack.push(child);
    }
  }
}

/** The block body of a function-like node, or null when it has none (`;`, `=> expr`). */
function blockBody(node: Node, language: CFamilyLanguage): Node | null {
  const braceType = language === 'c' ? 'compound_statement' : 'block';
  const body = node.childForFieldName('body') ?? node.namedChildren.find((c) => c?.type === braceType) ?? null;
  return body && body.type === braceType ? body : null;
}

function functionNodes(language: CFamilyLanguage): ReadonlySet<string> {
  return language === 'c' ? C_FUNCTION_NODES : CSHARP_FUNCTION_NODES;
}

/** A C function definition's name, through pointer and attributed declarators. */
function cFunctionName(definition: Node): string | null {
  let declarator = definition.childForFieldName('declarator');
  while (declarator && declarator.type !== 'function_declarator') {
    declarator = declarator.childForFieldName('declarator');
  }
  const name = declarator?.childForFieldName('declarator');
  return name && (name.type === 'identifier' || name.type === 'field_identifier') ? name.text : null;
}

/** The innermost enclosing C# type's name, or '' at top level. */
function enclosingType(node: Node): string {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (CSHARP_TYPE_NODES.has(parent.type)) return parent.childForFieldName('name')?.text ?? '';
  }
  return '';
}

/** The symbol a block-bodied declaration contributes, or null for an anonymous one. */
function symbolFor(node: Node, language: CFamilyLanguage): string | null {
  if (language === 'c') {
    const name = cFunctionName(node);
    return name ? `fn:${name}` : null;
  }
  const owner = enclosingType(node);
  const member = (text: string): string => `method:${owner ? `${owner}.` : ''}${text}`;
  const name = node.childForFieldName('name')?.text;
  switch (node.type) {
    case 'method_declaration':
    case 'constructor_declaration':
      return name ? member(name) : null;
    case 'destructor_declaration':
      return name ? member(`~${name}`) : null;
    case 'operator_declaration': {
      const op = node.childForFieldName('operator');
      return op ? member(`operator${op.text}`) : null;
    }
    case 'conversion_operator_declaration': {
      const type = node.childForFieldName('type');
      return type ? member(`operator ${type.text}`) : null;
    }
    case 'local_function_statement':
      return name ? `fn:${name}` : null;
    case 'accessor_declaration': {
      // accessor_declaration -> accessor_list -> property, indexer or event declaration
      const declaration = node.parent?.parent;
      const property =
        declaration?.childForFieldName('name')?.text ?? (declaration?.type === 'indexer_declaration' ? 'this[]' : null);
      return property && name ? member(`${property}.${name}`) : null;
    }
    default:
      return null; // lambda_expression, anonymous_method_expression: no name to take
  }
}

export function cFamilyRegions(root: Node, language: CFamilyLanguage): DeepRegion[] {
  const regions: DeepRegion[] = [];
  const kinds = functionNodes(language);
  walk(root, (node) => {
    if (!kinds.has(node.type)) return;
    const body = blockBody(node, language);
    if (!body) return;
    const start = body.startIndex + 1;
    const end = body.endIndex - 1;
    if (end > start) regions.push({ start, end });
  });
  return regions;
}

/** Each named block-bodied declaration with its whole span, header included. Tooling (§85). */
export function cFamilyDefinitions(root: Node, language: CFamilyLanguage): Definition[] {
  const out: Definition[] = [];
  const kinds = functionNodes(language);
  walk(root, (node) => {
    if (!kinds.has(node.type) || !blockBody(node, language)) return;
    const symbol = symbolFor(node, language);
    if (symbol) out.push({ symbol, start: node.startIndex, end: node.endIndex });
  });
  return out.sort((a, b) => a.start - b.start);
}

export function cFamilySymbols(root: Node, language: CFamilyLanguage): Set<string> {
  return new Set(cFamilyDefinitions(root, language).map((d) => d.symbol));
}
