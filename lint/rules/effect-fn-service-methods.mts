// Every method of a service (EFFECT.md, section 7) is
// `Effect.fn("Service.method")`, so each call has a span. In a service
// module (../serviceModule.mts), a method its tag's interface types as
// returning an `Effect.Effect` that the module hands `of` as a plain
// function, inline or bound to a name, is reported. A method returning
// a stream or a plain value is no Effect.fn, and one built some other
// way (a forwarder, a sub-maker's) is left alone, as is a tag whose
// interface is a named type.
import { isServiceModule } from "../serviceModule.mts";
import type { Node, Rule } from "../types.mts";

type Expression = Node<"VariableDeclarator">["init"];
type Pattern = Node<"VariableDeclarator">["id"];
type TypeNode = Node<"TSTypeAnnotation">["typeAnnotation"];

const isFunction = (node: Expression | undefined): boolean =>
  node?.type === "ArrowFunctionExpression" ||
  node?.type === "FunctionExpression";

// `Effect.Effect<...>`.
const isEffectType = (node: TypeNode | undefined): boolean =>
  node?.type === "TSTypeReference" &&
  node.typeName.type === "TSQualifiedName" &&
  node.typeName.left.type === "Identifier" &&
  node.typeName.left.name === "Effect" &&
  node.typeName.right.name === "Effect";

// The names a destructuring pattern binds.
function boundNames(pattern: Pattern): string[] {
  switch (pattern.type) {
    case "Identifier":
      return [pattern.name];
    case "ObjectPattern":
      return pattern.properties.flatMap((property) =>
        boundNames(
          property.type === "RestElement" ? property.argument : property.value,
        ),
      );
    case "ArrayPattern":
      return pattern.elements.flatMap((element) =>
        element === null
          ? []
          : boundNames(
              element.type === "RestElement" ? element.argument : element,
            ),
      );
    case "AssignmentPattern":
      return boundNames(pattern.left);
    default:
      return [];
  }
}

// The names of the members `shape` types as functions returning an effect.
function effectMethods(shape: TypeNode): Set<string> {
  const names = new Set<string>();
  if (shape.type !== "TSTypeLiteral") return names;
  for (const member of shape.members) {
    if (
      (member.type !== "TSMethodSignature" &&
        member.type !== "TSPropertySignature") ||
      member.key.type !== "Identifier"
    ) {
      continue;
    }
    if (member.type === "TSMethodSignature") {
      if (isEffectType(member.returnType?.typeAnnotation)) {
        names.add(member.key.name);
      }
    } else {
      const type = member.typeAnnotation?.typeAnnotation;
      if (
        type?.type === "TSFunctionType" &&
        isEffectType(type.returnType?.typeAnnotation)
      ) {
        names.add(member.key.name);
      }
    }
  }
  return names;
}

export default {
  meta: {
    docs: {
      description:
        "Require Effect.fn on every effect method a service module's tag is built with.",
    },
  },
  create(context) {
    if (!isServiceModule(context.filename)) return {};
    // Each tag's effect methods, by the tag's name.
    const tags = new Map<string, Set<string>>();
    // The names the module binds to a plain function, and the names it
    // binds to anything else: a name bound both ways, in two scopes, is
    // left alone.
    const functions = new Set<string>();
    const others = new Set<string>();
    const calls: Node<"CallExpression">[] = [];
    const check = (node: Node<"CallExpression">) => {
      const { callee } = node;
      const [shape] = node.arguments;
      if (
        callee.type !== "MemberExpression" ||
        callee.computed ||
        callee.property.type !== "Identifier" ||
        callee.property.name !== "of" ||
        callee.object.type !== "Identifier" ||
        shape?.type !== "ObjectExpression"
      ) {
        return;
      }
      const tag = callee.object.name;
      const methods = tags.get(tag);
      if (!methods) return;
      for (const property of shape.properties) {
        if (
          property.type !== "Property" ||
          property.computed ||
          property.key.type !== "Identifier" ||
          !methods.has(property.key.name)
        ) {
          continue;
        }
        const { value } = property;
        const plain =
          property.method ||
          isFunction(value) ||
          (value.type === "Identifier" &&
            functions.has(value.name) &&
            !others.has(value.name));
        if (!plain) continue;
        context.report({
          node: property,
          message: `A service method is \`Effect.fn("${tag}.${property.key.name}")\`, not a plain function (EFFECT.md, section 7).`,
        });
      }
    };
    return {
      // class Tag extends Context.Service<Tag, { ... }>()("sm/...") {}
      ClassDeclaration(node) {
        const outer = node.superClass;
        if (!node.id || outer?.type !== "CallExpression") return;
        const inner = outer.callee;
        if (inner.type !== "CallExpression") return;
        const service = inner.callee;
        const shape = inner.typeArguments?.params[1];
        if (
          service.type === "MemberExpression" &&
          !service.computed &&
          service.property.type === "Identifier" &&
          service.property.name === "Service" &&
          shape
        ) {
          tags.set(node.id.name, effectMethods(shape));
        }
      },
      VariableDeclarator(node) {
        if (node.id.type === "Identifier") {
          (isFunction(node.init) ? functions : others).add(node.id.name);
        } else {
          for (const name of boundNames(node.id)) others.add(name);
        }
      },
      ImportDeclaration(node) {
        for (const specifier of node.specifiers) {
          others.add(specifier.local.name);
        }
      },
      FunctionDeclaration(node) {
        if (node.id) functions.add(node.id.name);
      },
      CallExpression(node) {
        calls.push(node);
      },
      // At the end, since a tag's interface and the names `of` is handed
      // may come after the call in the module.
      "Program:exit"() {
        for (const node of calls) check(node);
      },
    };
  },
} satisfies Rule;
