; Tree-sitter tag query for JavaScript and JSX.
; Adapted from Aider (github.com/Aider-AI/aider, MIT licensed)
; aider/queries/tree-sitter-language-pack/javascript-tags.scm
;
; Aider's original includes (#strip!) and (#select-adjacent!) predicates
; for docstring extraction. The node-tree-sitter native bindings don't
; support custom predicates beyond #eq?/#not-eq?/#match?/#not-match?, so
; this file removes the doc-extraction comment captures and predicates.
; CodeLens doesn't use docstrings — it only needs the definition and
; reference captures for the call graph.

(method_definition
  name: (property_identifier) @name.definition.method) @definition.method

(class
  name: (_) @name.definition.class) @definition.class

(class_declaration
  name: (_) @name.definition.class) @definition.class

(function_expression
  name: (identifier) @name.definition.function) @definition.function

(function_declaration
  name: (identifier) @name.definition.function) @definition.function

(generator_function
  name: (identifier) @name.definition.function) @definition.function

(generator_function_declaration
  name: (identifier) @name.definition.function) @definition.function

(lexical_declaration
  (variable_declarator
    name: (identifier) @name.definition.function
    value: [(arrow_function) (function_expression)]) @definition.function)

(variable_declaration
  (variable_declarator
    name: (identifier) @name.definition.function
    value: [(arrow_function) (function_expression)]) @definition.function)

(assignment_expression
  left: [
    (identifier) @name.definition.function
    (member_expression
      property: (property_identifier) @name.definition.function)
  ]
  right: [(arrow_function) (function_expression)]
) @definition.function

(pair
  key: (property_identifier) @name.definition.function
  value: [(arrow_function) (function_expression)]) @definition.function

(call_expression
  function: (identifier) @name.reference.call) @reference.call

(call_expression
  function: (member_expression
    property: (property_identifier) @name.reference.call)) @reference.call

(new_expression
  constructor: (_) @name.reference.class) @reference.class
