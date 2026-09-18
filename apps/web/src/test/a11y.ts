import axe, { type ImpactValue } from "axe-core";

export async function axeViolations(container: HTMLElement, impacts: ReadonlyArray<ImpactValue>) {
  const { violations } = await axe.run(container);
  return violations.filter(({ impact }) => impact !== undefined && impacts.includes(impact));
}
