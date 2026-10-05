import type { ReactElement } from "react";
import { SelectBox } from "./fields/SelectBox";
import type { PaginationPageSize } from "./PaginationBar";

export interface PageSizeSelectProps<T extends PaginationPageSize> {
  value: NoInfer<T>;
  options: readonly T[];
  onChange: (value: NoInfer<T>) => void;
  isDisabled?: boolean;
  className?: string;
}
const allowedSizes: readonly PaginationPageSize[] = [10, 20, 50, 100, 500, 1000];
/** Also called when PaginationBar hides the selector; hidden values stay validated. */
export function validatePageSize<T extends PaginationPageSize>(value: T, options: readonly T[]): void {
  if (!options.length || new Set(options).size !== options.length || options.some(option => !allowedSizes.includes(option))) {
    throw new RangeError("pageSizeOptions must be nonempty, unique, and supported");
  }
  if (!options.includes(value)) throw new RangeError("pageSize must belong to pageSizeOptions");
}
export function PageSizeSelect<T extends PaginationPageSize>({ value, options, onChange, isDisabled = false, className }: PageSizeSelectProps<T>): ReactElement {
  validatePageSize(value, options);
  return <SelectBox label="페이지당 항목 수" size="sm" className={className} items={options.map(id => ({ id, label: `${id}개` }))}
    selectedKey={value} isDisabled={isDisabled} onSelectionChange={next => { if (!isDisabled && next !== null) onChange(next); }} />;
}
