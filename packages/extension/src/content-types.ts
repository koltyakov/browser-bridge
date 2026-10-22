/** Shared in-memory patch records. Type-only imports keep content scripts classic scripts. */
export type StyleValue = { value: string; priority: string };

export type StoredStylePatch = {
  kind: 'style';
  element: Element;
  elementRef: string;
  previous: Map<string, StyleValue>;
  shorthands: Map<string, StyleValue & { longhands: string[] }>;
};

export type StoredDomPatch = {
  kind: 'dom';
  element: Element;
  elementRef: string;
  operation: string;
  previous: {
    children: Node[] | null;
    attributes: Record<string, string | null>;
    toggledClass: string | null;
    hadClass: boolean | null;
    changed: boolean | null;
  };
};

export type StoredPatch = StoredStylePatch | StoredDomPatch;
