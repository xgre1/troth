; Tree-sitter tag query for Python.
; Sourced verbatim from Aider (github.com/Aider-AI/aider, MIT licensed)
; aider/queries/tree-sitter-language-pack/python-tags.scm
;
; Captures top-level constant assignments, class definitions, function
; definitions, and call references (both bare calls and attribute calls).

(module (expression_statement (assignment left: (identifier) @name.definition.constant) @definition.constant))

(class_definition
  name: (identifier) @name.definition.class) @definition.class

(function_definition
  name: (identifier) @name.definition.function) @definition.function

(call
  function: [
      (identifier) @name.reference.call
      (attribute
        attribute: (identifier) @name.reference.call)
  ]) @reference.call
