// ─────────────────────────────────────────────────────────────────────────────
// Single source of truth for every enum, dropdown option, and color used across
// forms, badges, charts, the dashboard, the body map and the printable reports.
// Import from here only. The server does not check these values: historical
// incidents brought in by import may carry others, and the screens fall
// back to a neutral label for a key they do not know.
// ─────────────────────────────────────────────────────────────────────────────

// ── Incident type / classification ───────────────────────────────────────────
export const INCIDENT_TYPES = [
  { key: 'near_miss', label: 'Near Miss', color: '#0ea5e9' },
  { key: 'first_aid', label: 'First Aid Injury', color: '#22c55e' },
  { key: 'lost_time', label: 'Lost Time Injury', color: '#f59e0b' },
  { key: 'reportable', label: 'Reportable Injury', color: '#ef4444' },
  { key: 'property_damage', label: 'Property Damage', color: '#a855f7' },
]
export const INCIDENT_TYPE_BY_KEY = Object.fromEntries(INCIDENT_TYPES.map((t) => [t.key, t]))
// Types that warrant a per-person injury report (everything except near-miss /
// property damage).
export const INJURY_REQUIRED_TYPES = ['first_aid', 'lost_time', 'reportable']
export const typeRequiresInjury = (key) => INJURY_REQUIRED_TYPES.includes(key)

// ── Severity (Level of Incident) ──────────────────────────────────────────────
export const SEVERITY = [
  { key: 'low', label: 'Low', color: '#22c55e' },
  { key: 'medium', label: 'Medium', color: '#f59e0b' },
  { key: 'high', label: 'High', color: '#f97316' },
  { key: 'critical', label: 'Critical', color: '#dc2626' },
]
export const SEVERITY_BY_KEY = Object.fromEntries(SEVERITY.map((s) => [s.key, s]))

// ── HSE "kind of accident" categories (RIDDOR-aligned) ────────────────────────
export const HSE_CATEGORIES = [
  { key: 'slip_trip_fall', label: 'Slip, Trip or Fall (same level)', color: '#0891b2' },
  { key: 'fall_from_height', label: 'Fall from Height', color: '#2563eb' },
  { key: 'struck_by_moving_object', label: 'Struck by Moving / Falling Object', color: '#7c3aed' },
  { key: 'contact_with_machinery', label: 'Contact with Machinery', color: '#db2777' },
  { key: 'manual_handling', label: 'Manual Handling / Lifting', color: '#f59e0b' },
  { key: 'vehicle', label: 'Struck by Vehicle', color: '#ea580c' },
  { key: 'electricity', label: 'Contact with Electricity', color: '#eab308' },
  { key: 'exposure_to_substance', label: 'Exposure to Harmful Substance', color: '#16a34a' },
  { key: 'fire_explosion', label: 'Fire / Explosion', color: '#dc2626' },
  { key: 'assault', label: 'Act of Violence / Assault', color: '#9333ea' },
  { key: 'other', label: 'Other', color: '#64748b' },
]
export const HSE_CATEGORY_BY_KEY = Object.fromEntries(HSE_CATEGORIES.map((c) => [c.key, c]))

// ── Locations (controlled enum — keeps byLocation stat keys clean) ────────────
export const LOCATIONS = [
  'Office',
  'Production Floor',
  'Warehouse',
  'Loading Dock',
  'Workshop',
  'Laboratory',
  'Construction Site',
  'Car Park',
  'Canteen / Kitchen',
  'Outdoor / Yard',
  'Other',
]

// ── Incident lifecycle ────────────────────────────────────────────────────────
export const LIFECYCLE = [
  { key: 'reporting', label: 'Reporting', color: '#0ea5e9' },
  { key: 'investigation_team', label: 'Team Formed', color: '#795548' },
  { key: 'investigation', label: 'Investigation', color: '#8b5cf6' },
  { key: 'capa', label: 'CAPA', color: '#f59e0b' },
  { key: 'horizontal', label: 'Horizontal Deployment', color: '#ec4899' },
  { key: 'closed', label: 'Closed', color: '#22c55e' },
]
export const LIFECYCLE_KEYS = LIFECYCLE.map((l) => l.key)
export const LIFECYCLE_BY_KEY = Object.fromEntries(LIFECYCLE.map((l) => [l.key, l]))
// Wizard step order ↔ lifecycle stage the step completes.

// ── Action (CAPA + illness corrective) status ─────────────────────────────────
export const ACTION_STATUS = [
  { key: 'open', label: 'Open', color: '#ef4444' },
  { key: 'in_progress', label: 'In Progress', color: '#f59e0b' },
  { key: 'closed', label: 'Closed', color: '#22c55e' },
]
export const ACTION_STATUS_BY_KEY = Object.fromEntries(ACTION_STATUS.map((s) => [s.key, s]))
export const ACTION_KINDS = [
  { key: 'corrective', label: 'Corrective' },
  { key: 'preventive', label: 'Preventive' },
]

// ── Investigation methods ─────────────────────────────────────────────────────
export const INVESTIGATION_METHODS = [
  { key: '5why', label: '5-Why Analysis', desc: 'Iteratively ask “why” to reach the root cause.' },
  { key: 'fishbone', label: 'Fishbone (Ishikawa)', desc: 'Group causes under the 6 M categories.' },
  { key: 'bowtie', label: 'Bow-Tie Analysis', desc: 'Threats → barriers → top event → barriers → consequences.' },
  { key: 'fta', label: 'Fault Tree Analysis', desc: 'Top-down logic gates (AND/OR) to basic events.' },
  { key: 'eta', label: 'Event Tree Analysis', desc: 'Initiating event branching by success/failure.' },
]
export const INVESTIGATION_METHOD_BY_KEY = Object.fromEntries(INVESTIGATION_METHODS.map((m) => [m.key, m]))

// Fishbone 6M categories.

// ── Injury reference ──────────────────────────────────────────────────────────
export const INJURY_TYPES = [
  'Cut / Laceration',
  'Fracture',
  'Burn (Heat / Chemical)',
  'Sprain / Strain',
  'Bruise / Contusion',
  'Dislocation',
  'Amputation',
  'Crush Injury',
  'Eye Injury',
  'Electric Shock',
  'Concussion / Head Injury',
  'Other',
]

// ── Body parts (key = BodyMap SVG region id; shared by injury + illness) ───────
// group: external | internal · view: front | back | internal
export const BODY_PARTS = [
  // External — front
  { key: 'head', label: 'Head', group: 'external', view: 'front' },
  { key: 'face', label: 'Face', group: 'external', view: 'front' },
  { key: 'eye', label: 'Eye(s)', group: 'external', view: 'front' },
  { key: 'neck', label: 'Neck', group: 'external', view: 'front' },
  { key: 'chest', label: 'Chest', group: 'external', view: 'front' },
  { key: 'abdomen', label: 'Abdomen', group: 'external', view: 'front' },
  { key: 'pelvis', label: 'Pelvis / Groin', group: 'external', view: 'front' },
  { key: 'shoulder_l', label: 'Left Shoulder', group: 'external', view: 'front' },
  { key: 'shoulder_r', label: 'Right Shoulder', group: 'external', view: 'front' },
  { key: 'arm_l', label: 'Left Arm', group: 'external', view: 'front' },
  { key: 'arm_r', label: 'Right Arm', group: 'external', view: 'front' },
  { key: 'hand_l', label: 'Left Hand', group: 'external', view: 'front' },
  { key: 'hand_r', label: 'Right Hand', group: 'external', view: 'front' },
  { key: 'thigh_l', label: 'Left Thigh', group: 'external', view: 'front' },
  { key: 'thigh_r', label: 'Right Thigh', group: 'external', view: 'front' },
  { key: 'knee_l', label: 'Left Knee', group: 'external', view: 'front' },
  { key: 'knee_r', label: 'Right Knee', group: 'external', view: 'front' },
  { key: 'lowerleg_l', label: 'Left Lower Leg', group: 'external', view: 'front' },
  { key: 'lowerleg_r', label: 'Right Lower Leg', group: 'external', view: 'front' },
  { key: 'foot_l', label: 'Left Foot', group: 'external', view: 'front' },
  { key: 'foot_r', label: 'Right Foot', group: 'external', view: 'front' },
  // Joints & extremities (external — front)
  { key: 'elbow_l', label: 'Left Elbow', group: 'external', view: 'front' },
  { key: 'elbow_r', label: 'Right Elbow', group: 'external', view: 'front' },
  { key: 'wrist_l', label: 'Left Wrist', group: 'external', view: 'front' },
  { key: 'wrist_r', label: 'Right Wrist', group: 'external', view: 'front' },
  { key: 'fingers_l', label: 'Left Fingers', group: 'external', view: 'front' },
  { key: 'fingers_r', label: 'Right Fingers', group: 'external', view: 'front' },
  { key: 'thumb_l', label: 'Left Thumb', group: 'external', view: 'front' },
  { key: 'thumb_r', label: 'Right Thumb', group: 'external', view: 'front' },
  { key: 'hip_l', label: 'Left Hip', group: 'external', view: 'front' },
  { key: 'hip_r', label: 'Right Hip', group: 'external', view: 'front' },
  { key: 'ankle_l', label: 'Left Ankle', group: 'external', view: 'front' },
  { key: 'ankle_r', label: 'Right Ankle', group: 'external', view: 'front' },
  // Specific fingers (thumb already above) — left then right
  { key: 'finger_l_index', label: 'Left Index Finger', group: 'external', view: 'front' },
  { key: 'finger_l_middle', label: 'Left Middle Finger', group: 'external', view: 'front' },
  { key: 'finger_l_ring', label: 'Left Ring Finger', group: 'external', view: 'front' },
  { key: 'finger_l_little', label: 'Left Little Finger', group: 'external', view: 'front' },
  { key: 'finger_r_index', label: 'Right Index Finger', group: 'external', view: 'front' },
  { key: 'finger_r_middle', label: 'Right Middle Finger', group: 'external', view: 'front' },
  { key: 'finger_r_ring', label: 'Right Ring Finger', group: 'external', view: 'front' },
  { key: 'finger_r_little', label: 'Right Little Finger', group: 'external', view: 'front' },
  // Specific toes — left then right
  { key: 'toe_l_big', label: 'Left Big Toe', group: 'external', view: 'front' },
  { key: 'toe_l_2', label: 'Left 2nd Toe', group: 'external', view: 'front' },
  { key: 'toe_l_3', label: 'Left 3rd Toe', group: 'external', view: 'front' },
  { key: 'toe_l_4', label: 'Left 4th Toe', group: 'external', view: 'front' },
  { key: 'toe_l_little', label: 'Left Little Toe', group: 'external', view: 'front' },
  { key: 'toe_r_big', label: 'Right Big Toe', group: 'external', view: 'front' },
  { key: 'toe_r_2', label: 'Right 2nd Toe', group: 'external', view: 'front' },
  { key: 'toe_r_3', label: 'Right 3rd Toe', group: 'external', view: 'front' },
  { key: 'toe_r_4', label: 'Right 4th Toe', group: 'external', view: 'front' },
  { key: 'toe_r_little', label: 'Right Little Toe', group: 'external', view: 'front' },
  // External — back
  { key: 'back_upper', label: 'Upper Back', group: 'external', view: 'back' },
  { key: 'back_lower', label: 'Lower Back', group: 'external', view: 'back' },
  { key: 'buttocks', label: 'Buttocks', group: 'external', view: 'back' },
  { key: 'nape', label: 'Back of Head / Nape', group: 'external', view: 'back' },
  { key: 'calf_l', label: 'Left Calf', group: 'external', view: 'back' },
  { key: 'calf_r', label: 'Right Calf', group: 'external', view: 'back' },
  // Internal organs
  { key: 'brain', label: 'Brain', group: 'internal', view: 'internal' },
  { key: 'lung', label: 'Lungs', group: 'internal', view: 'internal' },
  { key: 'heart', label: 'Heart', group: 'internal', view: 'internal' },
  { key: 'liver', label: 'Liver', group: 'internal', view: 'internal' },
  { key: 'stomach', label: 'Stomach', group: 'internal', view: 'internal' },
  { key: 'kidney', label: 'Kidneys', group: 'internal', view: 'internal' },
  { key: 'intestine', label: 'Intestines', group: 'internal', view: 'internal' },
  { key: 'spine', label: 'Spine', group: 'internal', view: 'internal' },
]
export const BODY_PART_BY_KEY = Object.fromEntries(BODY_PARTS.map((b) => [b.key, b]))
export const bodyPartLabel = (key) => BODY_PART_BY_KEY[key]?.label || key
export const BODY_VIEWS = [
  { key: 'front', label: 'Front' },
  { key: 'back', label: 'Back' },
  { key: 'internal', label: 'Internal' },
]

// ── Illness reference ─────────────────────────────────────────────────────────
// HSE health-affecting agents.
export const HSE_HEALTH_AGENTS = [
  'Asbestos',
  'Silica / Respirable Crystalline Dust',
  'Wood Dust',
  'Lead',
  'Isocyanates',
  'Solvents / VOCs',
  'Welding Fume',
  'Biological Agents',
  'Legionella',
  'Noise',
  'Hand-Arm Vibration',
  'Ionising Radiation',
  'Sensitising Chemicals / Allergens',
  'Carbon Monoxide',
  'Other',
]

export const PPE_OPTIONS = [
  'Gloves',
  'Respirator / Mask',
  'Goggles / Face Shield',
  'Ear Protection',
  'Coveralls',
  'Safety Boots',
  'Hi-Vis Vest',
  'Hard Hat',
  'Apron',
  'None',
]

// ── Person kinds (affected personnel / team / owners) ─────────────────────────
export const PERSON_KINDS = [
  { key: 'internal', label: 'Internal' },
  { key: 'external', label: 'External' },
]

// Max source file size for base64 uploads (photos / medical records / attachments).
// Base64 inflates ~33%, so 750 KB → ~1 MB encoded — kept under Firestore's doc cap.
// Files go to cloud storage now; this is the product limit, not a Firestore
// document limit. The inline-fallback ceiling lives in shared/storage.
export { MAX_UPLOAD_BYTES as MAX_FILE_BYTES } from '../../../shared/storage'
