import { OWNER_DEPARTMENT, OWNER_PERSON, actionOwnerKind } from '../lib/actionOwner'

/**
 * Exactly one responsible party for a committee action.
 *
 * Department comes from the org list when that list has names. An empty list
 * is a text field, so a meeting can still name a department the org has not
 * configured. Person is the member list the form already used. Switching
 * side clears the other value.
 */
export default function ActionOwnerField({
  users = [],
  departments = [],
  value = {},
  onChange,
  disabled = false,
  name = 'action-owner',
}) {
  const kind = actionOwnerKind(value)
  const people = users.map((u) => u.name || u.email).filter(Boolean)
  // The name is what the meeting shows (and is sealed); the uid is who the
  // server tells about the action (stack/lib/notify.js).
  const uidOf = (label) => {
    const u = users.find((x) => (x.name || x.email) === label)
    return u?.id || u?.uid || ''
  }
  const personValue = kind === OWNER_PERSON ? value.owner || '' : ''
  const departmentValue = kind === OWNER_DEPARTMENT ? value.department || '' : ''
  const personOptions =
    personValue && !people.includes(personValue) ? [personValue, ...people] : people
  const departmentOptions =
    departmentValue && !departments.includes(departmentValue)
      ? [departmentValue, ...departments]
      : departments

  const choose = (nextKind) => {
    if (disabled || nextKind === kind) return
    onChange(
      nextKind === OWNER_DEPARTMENT
        ? { ownerKind: OWNER_DEPARTMENT, department: '', owner: '', ownerUid: '' }
        : { ownerKind: OWNER_PERSON, owner: '', department: '', ownerUid: '' }
    )
  }

  return (
    <fieldset className="min-w-0 border-0 p-0" disabled={disabled}>
      <legend className="sr-only">Responsible party</legend>
      <div className="mb-2 flex gap-3 text-[11px] font-bold text-ink-600">
        <label className="inline-flex items-center gap-1.5">
          <input
            type="radio"
            name={name}
            value={OWNER_DEPARTMENT}
            checked={kind === OWNER_DEPARTMENT}
            onChange={() => choose(OWNER_DEPARTMENT)}
          />
          Department
        </label>
        <label className="inline-flex items-center gap-1.5">
          <input
            type="radio"
            name={name}
            value={OWNER_PERSON}
            checked={kind === OWNER_PERSON}
            onChange={() => choose(OWNER_PERSON)}
          />
          Person
        </label>
      </div>
      {kind === OWNER_DEPARTMENT ? (
        departmentOptions.length > 0 ? (
          <select
            aria-label="Department"
            value={departmentValue}
            disabled={disabled}
            onChange={(e) =>
              onChange({
                ownerKind: OWNER_DEPARTMENT,
                department: e.target.value,
                owner: '',
                ownerUid: '',
              })
            }
            className="w-full bg-surface border border-surface-200 rounded-lg p-2 text-xs font-bold text-blue-600 outline-hidden focus:border-blue-500 transition-colors"
          >
            <option value="">Select department…</option>
            {departmentOptions.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        ) : (
          <input
            aria-label="Department name"
            value={departmentValue}
            disabled={disabled}
            maxLength={120}
            placeholder="Department name"
            onChange={(e) =>
              onChange({
                ownerKind: OWNER_DEPARTMENT,
                department: e.target.value,
                owner: '',
                ownerUid: '',
              })
            }
            className="w-full bg-surface border border-surface-200 rounded-lg p-2 text-xs font-bold text-blue-600 outline-hidden focus:border-blue-500 transition-colors"
          />
        )
      ) : (
        <select
          aria-label="Person"
          value={personValue}
          disabled={disabled}
          onChange={(e) =>
            onChange({
              ownerKind: OWNER_PERSON,
              owner: e.target.value,
              department: '',
              ownerUid: uidOf(e.target.value),
            })
          }
          className="w-full bg-surface border border-surface-200 rounded-lg p-2 text-xs font-bold text-blue-600 outline-hidden focus:border-blue-500 transition-colors"
        >
          <option value="">Select person…</option>
          {personOptions.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      )}
    </fieldset>
  )
}
