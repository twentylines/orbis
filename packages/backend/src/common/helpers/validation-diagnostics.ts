export function validationDiagnostic(label: string, errors: Iterable<{ path: readonly PropertyKey[] }>, isKnownField: (field: string) => boolean) {
  const fields = [
    ...new Set(Array.from(errors, (error) => error.path[0]).filter((field): field is string => typeof field === 'string' && isKnownField(field))),
  ].sort();
  return fields.length ? `${label}: ${fields.join(', ')}` : label;
}
