declare const brand: unique symbol;
/** Nominal type: a plain number is not assignable to Brand<number, 'WorkItemId'>. */
export type Brand<T, B extends string> = T & { readonly [brand]: B };
