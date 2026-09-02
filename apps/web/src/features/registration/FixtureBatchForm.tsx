import { CheckCircle2, Loader2 } from "lucide-react";
import { Button } from "../../components/ui";

export interface FixtureBatchDefaults {
  namePrefix: string;
  startNumber: number;
  digits: number;
  ratedWatt: string;
  size: number;
}

interface FixtureBatchFormProps {
  values: FixtureBatchDefaults;
  selectedCount: number;
  disabled: boolean;
  pending: boolean;
  onChange: (values: FixtureBatchDefaults) => void;
  onSubmit: () => void;
}

export function FixtureBatchForm({
  values,
  selectedCount,
  disabled,
  pending,
  onChange,
  onSubmit
}: FixtureBatchFormProps) {
  return (
    <form className="registration-config-form" onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
      <div className="registration-fields batch-fields">
        <label>
          이름 접두어
          <input
            value={values.namePrefix}
            maxLength={100}
            onChange={(event) => onChange({ ...values, namePrefix: event.target.value })}
          />
        </label>
        <label>
          시작 번호
          <input
            type="number"
            min={1}
            step={1}
            value={values.startNumber}
            onChange={(event) => onChange({ ...values, startNumber: Number(event.target.value) })}
          />
        </label>
        <label>
          자릿수
          <input
            type="number"
            min={1}
            max={9}
            step={1}
            value={values.digits}
            onChange={(event) => onChange({ ...values, digits: Number(event.target.value) })}
          />
        </label>
        <label>
          정격 전력(W)
          <input
            inputMode="decimal"
            value={values.ratedWatt}
            onChange={(event) => onChange({ ...values, ratedWatt: event.target.value })}
          />
        </label>
        <label>
          조명 크기
          <input
            type="number"
            min={1}
            max={1000}
            value={values.size}
            onChange={(event) => onChange({ ...values, size: Number(event.target.value) })}
          />
        </label>
      </div>
      <RegistrationSubmitButton selectedCount={selectedCount} disabled={disabled} pending={pending} />
    </form>
  );
}

export function RegistrationSubmitButton({
  selectedCount,
  disabled,
  pending
}: {
  selectedCount: number;
  disabled: boolean;
  pending: boolean;
}) {
  return (
    <Button
      className="registration-submit"
      variant="primary"
      type="submit"
      aria-label="선택 조명 등록"
      disabled={disabled}
      isLoading={pending}
      loadingLabel="선택 조명 등록 중"
    >
      <>{pending ? <Loader2 size={16} /> : <CheckCircle2 size={16} />} 선택 조명 등록 <span>{selectedCount}</span></>
    </Button>
  );
}
