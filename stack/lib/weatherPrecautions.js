// Activity-specific precautions for the weather-risk digest.
//
// The High-risk table used to print one paragraph per hazard, the same for a
// gym and a construction yard. The wording now follows the work the
// organisation has actually recorded, and the work recorded at the site when
// that is more specific. Nothing recorded still prints the general paragraph
// (GENERIC_PRECAUTIONS). The mail layout and the admin recipient list are
// untouched.
//
// Where the activities come from
//
// 1. organisations/{orgId}.activityTypes — Org settings → Activities
//    performed. This is the only org-wide activity list. There is no separate
//    industry field. The built-in choices live in src/shared/org/orgConstants.js
//    (ACTIVITY_TYPES); admins can add their own labels.
// 2. organisations/{orgId}.weatherPrecautions — the same screen. An override
//    of the built-in sentence for one activity and one alert. Blank means the
//    built-in sentence.
// 3. The site document. site.facility is the site type, asked for when a site
//    is added (the form and the spreadsheet import). The general list is
//    SITE_TYPES. An organisation's own activities, including a custom label
//    with precautions written in Org Settings, are types too. An existing site
//    may still have none: the mail then uses the organisation's activities,
//    and the general paragraph when those are empty. An admin can fill those
//    blanks from the site's entity with the org's entity → site type map
//    (siteTypeBackfill.js). That write sets facility only, and only while it
//    is still blank. A custom attribute whose key is a type, category,
//    facility or activity field is still read when the site has no type.
//    site.activityTypes is honoured in that same case.
// 4. HIRA, organisations/{orgId}/assessments. Site-scoped rows (siteId,
//    siteName; baselines are skipped). Activity titles, hazard types and hazard
//    categories are matched. Free text that does not match the catalog is
//    ignored, so "inspect the site office" does not turn a yard into an office.
// 5. Permits, organisations/{orgId}/permits. typeOfWork and the hazard
//    multi-select. Matched on siteId when the permit has one, otherwise on the
//    site name (`site`). Job descriptions and the name the permit was issued
//    to are not read: one is not an activity, the other is personal data.
//
// A site profile (what the place is) replaces the organisation profile for
// that site. A task (hot work, height, electrical, a delivery) is added on
// top, because the yard is still a construction site when today's permit is
// hot work. The cell keeps at most three tasks and one profile so a long
// register cannot turn the row into a second mail.
//
// This module is pure on purpose. The SPA settings screen imports it, and the
// functions package cannot import the SPA. Firestore reads stay in
// loadPrecautionFor, which the digest calls. UV, visibility, wind, ice and
// snow are not alerts here. Heat High remains an air temperature strictly
// above 40°C, decided in weatherBands.js, not in this file.

export const ALERT_KEYS = ['heat', 'cold', 'rain', 'lightning', 'air']

export const ALERTS = [
  { key: 'heat', label: 'Heat Stress' },
  { key: 'cold', label: 'Cold Stress' },
  { key: 'rain', label: 'Rain Risk' },
  { key: 'lightning', label: 'Lightning' },
  { key: 'air', label: 'Air Quality' },
]

// The sentences the mail used before activities were consulted. Exported so
// the template and this file cannot each grow a private copy. An org with no
// activities still receives these, word for word.
const AIR_PRECAUTION =
  'Limit heavy outdoor work and move people into cleaner indoor air where you can. Pause hot work and work at height when breathing is hard, and follow the site plan for poor air quality.'

export const GENERIC_PRECAUTIONS = {
  heat: 'Provide cool drinking water and enforce shade and rest breaks. Move heavy outdoor work to the cooler hours. Watch for heat-illness signs (dizziness, cramps, confusion) and act at once.',
  cold: 'Provide warm clothing, gloves and warm rest breaks. Limit time on exposed tasks and watch for numbness or shivering. Check for ice on walkways and equipment.',
  rain: 'Watch for slips, trips and wet electrical equipment; keep tools and cables off wet ground. Secure loose materials and check drainage. Stop work at height and hot work if conditions are unsafe.',
  lightning:
    'Stop outdoor work and move people indoors or into a vehicle. Keep clear of tall structures, cranes, scaffolding and open ground. Resume only when the storm has passed.',
  air: AIR_PRECAUTION,
  other:
    'Review the task risk assessment. Stop work that cannot be done safely, and follow site emergency procedures.',
}

const MAX_TEXT = 500
const MAX_LABEL = 80
// Three tasks plus the place they are done in. A fourth task is used only
// when the site has no profile, so a permit-only site still gets more than
// one control.
const MAX_TASKS_WITH_PROFILE = 3
const MAX_LINES = 4

// How many HIRA rows and permits one digest will read. Past the cap the rest
// are missed, not guessed. orderBy is deliberately not used: a missing index
// would fail the read and drop every site activity for that org.
export const ASSESSMENT_CAP = 300
export const PERMIT_CAP = 500

const TYPE_KEYS = new Set([
  'type',
  'site_type',
  'sitetype',
  'facility',
  'facility_type',
  'category',
  'use',
  'activity',
  'activities',
  'site_use',
  'building_type',
  'format',
  'kind',
  'site_category',
  'site_kind',
])

// A task that is the specific form of a profile. Present together, the
// profile sentence would repeat the task, so the profile is left out.
const PARENT = {
  // The building is the specific form of a fitness estate. Present together,
  // the organisation sentence would repeat it, or contradict it: an indoor
  // pool is not told to cancel an outdoor class.
  indoorGym: 'fitness',
  indoorPool: 'fitness',
  indoorCourt: 'fitness',
  facilityWarehouse: 'fitness',
  outdoorGym: 'fitness',
  kitchen: 'food',
  driving: 'transportation',
  electrical: 'utilities',
}

const TASK_ORDER = [
  'hotwork',
  'height',
  'electrical',
  'confined',
  'excavation',
  'hazload',
  'driving',
  'outdoor',
]

const PROFILE_ORDER = [
  'indoorPool',
  'indoorGym',
  'indoorCourt',
  'facilityWarehouse',
  'outdoorGym',
  'kitchen',
  'healthcare',
  'education',
  'office',
  'retail',
  'hospitality',
  'food',
  'fitness',
  'warehousing',
  'manufacturing',
  'construction',
  'chemical',
  'oilgas',
  'mining',
  'utilities',
  'transportation',
  'agriculture',
  'waste',
  'facilities',
]

function px(heat, rain, _wind, _visibility, cold, lightning, _ice, _snow) {
  return { heat, cold, rain, lightning, air: AIR_PRECAUTION }
}

function entry(id, label, kind, extra, aliases, precautions) {
  return { id, label, kind, extra, aliases, precautions }
}

export const CATALOG = [
  entry(
    'manufacturing',
    'Manufacturing',
    'profile',
    false,
    ['factory', 'production line', 'manufacturing/plant', 'plant'],
    px(
      'Hot processes plus hot weather. Rotate people off furnaces, ovens and uncooled lines, provide water and cool breaks, and stop non-essential hot work in the hottest hours.',
      'Keep yards, loading docks and outdoor plant dry underfoot. Stop outdoor hot work and work at height, and keep electrical panels and leads out of standing water.',
      'Secure sheet materials, yard stock and temporary covers. Stop roof, crane and stack work.',
      'Slow yard plant and use spotters. Pause reversing and lifting where the operator cannot see.',
      'Warm breaks for yard, loading and cold-store tasks. Check external stairs and platforms for ice.',
      'Stop outdoor and rooftop work, including crane and stack access. Stay clear of the open yard until the storm has passed.',
      'Grit yards and external stairs. Stop work at height and on icy platforms.',
      'Clear yards and external access. Check roofs and gantries for snow load before use.'
    )
  ),
  entry(
    'construction',
    'Construction',
    'profile',
    false,
    ['civil works', 'civil work', 'outdoor site/construction', 'outdoor site'],
    px(
      'Schedule heavy outdoor and at-height work for the cooler hours. Provide shade, cool water and enforced rest, and stop hot work or roof work if anyone shows heat-illness signs (dizziness, cramps, confusion).',
      'Stop work at height, scaffolding and hot work when surfaces are wet. Keep cables and welding leads off wet ground, and check excavation drainage before anyone goes in.',
      'Stop crane lifts, scaffolding and roof work. Secure sheeting, formwork and loose materials, and keep people clear of edges and overhead loads.',
      'Stop crane lifts and reversing plant unless a spotter can see. Mark haul routes, and keep lights and high-visibility clothing on.',
      'Limit exposed outdoor and at-height tasks. Provide warm clothing and warm breaks, and check scaffolding, ladders and walkways for ice before use.',
      'Stop outdoor, roof and hot work. Clear scaffolding, cranes and open decks, and resume only when the storm has passed.',
      'Stop work at height and lifting on icy surfaces. Grit access routes and scaffold stairs, and do not climb wet or frozen ladders.',
      'Clear and grit access routes and scaffold stairs. Check temporary roofs and scaffolding for snow load before anyone goes up.'
    )
  ),
  entry(
    'warehousing',
    'Warehousing & Logistics',
    'profile',
    false,
    ['distribution centre', 'distribution center', 'logistics depot'],
    px(
      'Limit time in uncooled warehouses, trailers and the yard. Water and shade for pickers and loaders, and move heavy loading to the cooler hours.',
      'Keep dock levellers, ramps and pedestrian routes dry. Pause yard moves if water is standing, and do not use electrical pallet equipment on a wet dock.',
      'Secure yard trailers, doors and loose pallets. Stop work on trailer roofs and on high racking beside open doors.',
      'Slow yard vehicles. A spotter for reversing, and lights and high-visibility clothing on.',
      'Warm breaks for yard and chiller crews. Watch for numbness, and check dock ramps for ice.',
      'Close the dock doors. Stop outdoor yard work and roof access, and stay inside until the storm has passed.',
      'Grit the yard, the ramps and the dock approach. Slow vehicles, and stop work on trailer roofs.',
      'Clear the dock approach and the yard. Check the roof and the canopies for snow load before anyone goes up.'
    )
  ),
  entry(
    'retail',
    'Retail',
    'profile',
    false,
    ['shop', 'store floor', 'retail store'],
    px(
      'Cool the shop floor if you can, provide water for staff, and schedule outdoor queues, deliveries and car-park work for the cooler hours.',
      'Keep entrances and the sales floor dry. Pause outdoor queues and deliveries if the yard is flooding, and keep electrical displays away from wet doors.',
      'Secure external signage, trolleys and outdoor displays. Stop work at height on the facade.',
      'Light the car park and the entrance. Slow delivery vehicles, and use a spotter for reversing.',
      'Grit the entrance and the car park. Warm breaks for people on the door.',
      'Bring outdoor queues and trolley crews inside. Stay clear of the open car park until the storm has passed.',
      'Grit or close icy entrances, ramps and the car park before opening.',
      'Clear the entrance and the car park. Check canopies, and delay deliveries if the yard is not safe.'
    )
  ),
  entry(
    'healthcare',
    'Healthcare',
    'profile',
    false,
    ['hospital', 'clinic', 'ambulance'],
    px(
      'Protect patients and staff who cannot leave a hot ward or an ambulance bay. Provide water, cool the space, shorten outdoor transfers, and watch for heat illness in people who cannot speak up.',
      'Keep entrances, the ambulance bay and transfer routes dry and lit. Delay non-urgent outdoor patient moves.',
      'Secure external equipment, signage and temporary structures. Delay rooftop plant work and outdoor transfers.',
      'Slow ambulances and site vehicles. Light the bay, and use a spotter for reversing.',
      'Keep entrances clear of ice for patients and ambulances. Limit time on exposed transfers, and provide warm covers.',
      'Stop outdoor transfers and roof work. Keep clear of open bays until the storm has passed.',
      'Grit the ambulance bay, ramps and entrances first. Delay non-urgent outdoor moves.',
      'Clear the bay and the entrances. Check canopies for snow load before use.'
    )
  ),
  entry(
    'office',
    'Office / Administration',
    'profile',
    false,
    ['office', 'offices'],
    px(
      'Use cooled rooms for anyone who must stay, ease dress rules, and provide water. Check plant rooms, and anyone working outside the office, separately from the desk staff.',
      'Keep entrances, stairs and lobbies dry. Delay non-essential travel between buildings.',
      'Stay indoors. Reach rooftop plant only if it is safe, and cancel roof access while the wind holds.',
      'Delay travel between sites. Light the entrances and the car park.',
      'Check the entrance, the steps and the car park for ice before people arrive, and keep a warm room available.',
      'Stay inside, away from windows and roof plant. Do not cross an open car park until the storm has passed.',
      'Grit or close icy steps, ramps and the car park, and warn people at the entrance.',
      'Clear and grit the entrance and the car park. Check flat roofs and canopies before anyone goes up.'
    )
  ),
  entry(
    'chemical',
    'Chemical Processing',
    'profile',
    false,
    ['chemical plant', 'chemical processing'],
    px(
      'Limit time in hot process areas and in heavy chemical PPE. Cool water and shade, and do not extend a confined or outdoor task through the hottest hours.',
      'Stop outdoor hot work and work at height. Keep bunds and drainage clear, do not operate electrical equipment in standing water, and watch for product washed out of containment.',
      'Stop lifting and work on stacks and columns. Secure cylinders and loose covers, and keep people out of the downwind side of an open area.',
      'Slow site vehicles. Spotters for reversing, and pause any lift the operator cannot see.',
      'Limit exposed tasks. Watch for numbness inside gloves, and check stairs and platforms for ice.',
      'Stop outdoor hot work and work on tank roofs and columns. Clear open process areas until the storm has passed.',
      'Stop work at height and on icy platforms. Grit the access, and do not climb tank stairs while they are icy.',
      'Clear the access. Check roofs, pipe racks and temporary covers for snow load before anyone uses them.'
    )
  ),
  entry(
    'food',
    'Food & Beverage',
    'profile',
    false,
    ['food and beverage', 'food service', 'catering'],
    px(
      'Treat kitchens, dish rooms and uncooled stores as hotter than the forecast. Rotate people off ovens and grills, provide cool water and cool breaks, and move outdoor service to the cooler hours.',
      'Keep kitchen floors, entrances and the delivery yard dry. Pause outdoor service and deliveries if water is standing, and keep electrical equipment out of it.',
      'Secure canopies, outdoor furniture and signage. Pause terrace service and work at height on the facade.',
      'Slow delivery vehicles. Light the yard and the entrance, and use a spotter where a driver cannot see.',
      'Warm breaks for door, yard and cold-store staff. Limit time at the open delivery door, and check steps for ice.',
      'Close terraces and stop outdoor cooking and yard loading. Indoors, clear of canopies and open ground, until the storm has passed.',
      'Grit the entrance, steps and the delivery yard before service. Slow vehicles, and delay deliveries if the route is not safe.',
      'Clear the entrance and the yard. Check canopies and flat roofs for snow load, and cancel outdoor service.'
    )
  ),
  entry(
    'oilgas',
    'Oil & Gas',
    'profile',
    false,
    ['oil and gas', 'upstream', 'tank farm'],
    px(
      'Limit time on open process areas, tank roofs and in heavy PPE. Cool water, shade and a rest plan, and stop the task if anyone shows heat-illness signs.',
      'Stop hot work and work at height outdoors. Keep bunds draining, keep electrical equipment out of standing water, and watch for spills leaving containment.',
      'Stop lifting and work on columns, stacks and tank roofs. Secure cylinders and loose covers.',
      'Slow site vehicles and use spotters. Pause lifting and reversing the operator cannot see.',
      'Limit exposed tasks on units and in the yard. Dry gloves, warm breaks, and check stairs for ice.',
      'Stop outdoor hot work and clear tank roofs, columns and open ground. Resume only when the storm has passed.',
      'Stop work at height. Grit unit access and stairs, and do not climb an icy tank stair.',
      'Clear unit access. Check roofs, pipe racks and temporary covers for snow load before use.'
    )
  ),
  entry(
    'mining',
    'Mining & Quarrying',
    'profile',
    false,
    ['mining', 'quarry', 'quarrying'],
    px(
      'Schedule heavy pit and quarry work for the cooler hours. Water, shade and enforced rest, and watch haul-truck and drill crews for heat illness.',
      'Stop work on unstable faces, haul roads and at height if water is undermining them. Slow vehicles, and check drainage before anyone enters an excavation.',
      'Stop work at height and on exposed faces. Secure plant and temporary structures, and keep people clear of the downwind side.',
      'Stop haulage if drivers cannot see. Lights on, and no reversing without a spotter.',
      'Warm breaks and dry gloves for exposed crews. Check benches and access roads for ice.',
      'Clear pits, drills and high plant. Move into vehicles or indoors, and resume only when the storm has passed.',
      'Slow or stop haulage. Grit the access, and stop work at height.',
      'Clear haul roads and access. Check workshops and temporary structures for snow load before use.'
    )
  ),
  entry(
    'utilities',
    'Utilities & Energy',
    'profile',
    false,
    ['utilities', 'substation', 'overhead line'],
    px(
      'Schedule outdoor line, plant and substation work for the cooler hours. Water and rest for crews in electrical PPE, and stop if anyone shows heat-illness signs.',
      'Stop live outdoor electrical work. Keep clear of flooded substations and wet joint pits, and do not stand in water to operate gear.',
      'Stop pole, tower and crane work. Secure materials, and keep clear of overhead lines.',
      'Pause roadside and overhead work. Use spotters, and keep high-visibility clothing on.',
      'Limit time on exposed towers and in the yard. Dry gloves, and check the access for ice.',
      'Stop all outdoor electrical and line work immediately. Clear towers, poles and open ground until the storm has passed.',
      'Do not climb icy towers, poles or stairs. Grit the yard, and delay the climb.',
      'Clear substation access. Check roofs and gantries for snow load, and delay non-essential climbing.'
    )
  ),
  entry(
    'hospitality',
    'Hospitality',
    'profile',
    false,
    ['hotel', 'guest services'],
    px(
      'Move outdoor service indoors where you can. Water for kitchen, terrace and housekeeping staff, and shorten shifts in uncooled areas.',
      'Keep entrances, terraces and kitchen floors dry. Pause outdoor service and events, and watch wet stone and pool decks.',
      'Secure umbrellas, furniture and signage. Close terraces, and stop work at height on the facade.',
      'Light entrances and the car park. Slow site vehicles, and use a spotter in the yard.',
      'Grit guest entrances before arrival. Limit outdoor service, and give door and yard staff warm breaks.',
      'Close pools and terraces at the first thunder. Move guests and staff indoors until the storm has passed.',
      'Grit entrances, steps and the car park before guests arrive. Close icy terraces.',
      'Clear guest entrances and the car park. Check canopies and flat roofs, and cancel outdoor events.'
    )
  ),
  entry(
    'education',
    'Education',
    'profile',
    false,
    ['school', 'college', 'campus'],
    px(
      'Cancel or move outdoor sport and assemblies to the cooler hours or indoors. Water available, and watch children and staff for heat illness.',
      'Move outdoor lessons and sport indoors. Keep entrances and playgrounds from becoming slip routes, and delay off-site trips.',
      'Cancel outdoor sport. Secure temporary structures and shade sails, and keep people away from trees and fencing.',
      'Postpone outdoor sport and walking trips. Light the entrances.',
      'Shorten outdoor breaks. Check playgrounds and steps for ice before children go out.',
      'Stop outdoor sport and field trips at the first thunder. Stay indoors, away from open ground, until the storm has passed.',
      'Grit or close icy paths and steps. Move sport indoors.',
      'Clear entrances and paths. Cancel outdoor sport, and check temporary classrooms and canopies for snow load.'
    )
  ),
  entry(
    'transportation',
    'Transportation',
    'profile',
    false,
    ['fleet', 'haulage depot'],
    px(
      'Cool cabs, carry water, and avoid the hottest hours for loading. Do not leave staff in a parked vehicle.',
      'Slow vehicles, postpone exposed loading, and keep the yard from flooding chargers and dock equipment.',
      'Hold high-sided vehicles and motorcycles. Secure loads, and stop work on trailer roofs.',
      'Stop yard movement if drivers cannot see. Spotters for reversing, and lights on.',
      'Check each vehicle before it leaves. Warm breaks for loaders, and dry gloves.',
      'Stop outdoor loading. Drivers indoors or in the cab, not beside a high vehicle in the open.',
      'Delay departures. Grit the yard, and slow plant.',
      'Clear the yard and the docks. Clear vehicle roofs, and delay non-essential runs.'
    )
  ),
  entry(
    'agriculture',
    'Agriculture',
    'profile',
    false,
    ['farm', 'field work'],
    px(
      'Schedule field work for the cooler hours. Water, shade and rest for crews and anyone in PPE, and watch for heat illness away from buildings.',
      'Stop work on slopes and with machinery on wet ground, and stop work at height. Keep clear of flooded ditches and of electrical pumps standing in water.',
      'Stop spraying and work at height. Secure covers and temporary structures.',
      'Stop field machinery if the driver cannot see. Lights on.',
      'Limit exposed tasks. Dry gloves, and watch for shivering in crews who are away from the yard.',
      'Leave fields, machinery and open ground. Do not shelter under trees. Resume only when the storm has passed.',
      'Do not take machinery onto icy tracks. Grit the yard.',
      'Clear yard access. Check barns and temporary roofs for snow load, and delay field work.'
    )
  ),
  entry(
    'waste',
    'Waste Management',
    'profile',
    false,
    ['waste', 'transfer station', 'refuse'],
    px(
      'Rotate crews off uncooled vehicles, sorting halls and outdoor tips. Water and shade, and watch drivers who stay in a hot cab.',
      'Slow collection vehicles. Keep the transfer-station floor dry, stop work at height on vehicles and pits, and keep electrical sorting equipment out of standing water.',
      'Secure loose waste and covers. Stop work at height, and watch for material blown onto the road.',
      'Slow vehicles. Spotters at the tip face and in the hall, with lights and high-visibility clothing.',
      'Warm breaks. Check the steps on vehicles for ice before anyone climbs.',
      'Stop outdoor tipping and work on top of vehicles. Clear open ground until the storm has passed.',
      'Grit the yard and the hall entrance. Slow vehicles, and nobody on an icy vehicle roof.',
      'Clear the yard and the route out. Check roofs for snow load, and delay an exposed round if the route is not safe.'
    )
  ),
  entry(
    'facilities',
    'Facilities Management',
    'profile',
    false,
    ['facilities', 'caretaker', 'grounds maintenance'],
    px(
      'Schedule outdoor, plant-room and roof work for the cooler hours. Water and rest, especially in boiler rooms and on roofs.',
      'Stop roof, gutter and external electrical work. Keep plant rooms from flooding onto live equipment, and dry the entrance routes you look after.',
      'Stop roof, mast and facade work. Secure ladders and materials.',
      'Postpone rooftop and roadside work. Use a spotter where vehicles are moving.',
      'Limit exposed roof and grounds work. Check external stairs for ice.',
      'Get off roofs and away from masts and plant. Resume only when the storm has passed.',
      'Stop roof and ladder work. Grit the routes you maintain.',
      'Do not go on a roof until the snow load is checked. Clear the entrances you are responsible for.'
    )
  ),
  entry(
    'fitness',
    'Fitness & Recreation',
    'profile',
    false,
    [
      'fitness centre',
      'fitness center',
      'fitness centres',
      'fitness centers',
      'leisure centre',
      'leisure center',
    ],
    px(
      'Check air conditioning and ventilation are cooling studios and circulation spaces, and that temperature and humidity stay within the site limit. Keep hydration stations stocked, ease high-intensity classes, and watch staff and members for dizziness or confusion, including people who commuted in the heat.',
      'Check roofs, skylights and plant rooms for water ingress. Dry entrances, lay mats and put out wet-floor signs, and keep electrical equipment away from leaks. Check drains and basements so water is not pooling under the building.',
      'Keep members and staff inside. Secure external signage, doors and loose items at the entrance, and do not send anyone onto the roof or a plant deck while the wind holds.',
      'Light entrances and the car park. Slow vehicles at the entrance, and allow extra time for staff and members commuting in poor visibility.',
      'Check entrances, steps and the car park for ice before people arrive, and keep a warm space available. Confirm heating and ventilation are holding, and watch staff who have commuted in the cold.',
      'If the building has a roof or skylights, move people away from the glazed roof while lightning is close. On a power cut, switch to emergency lighting and follow the evacuation procedure. Do not restart electrical equipment until it has been checked.',
      'Grit or close icy entrances, steps and the car park before people arrive. Dry water tracked in at the door, and keep mats and wet-floor signs in place.',
      'Clear and grit entrances, steps and the car park. Check roofs and skylights for snow load before anyone goes up, and allow extra time for staff and members commuting.'
    )
  ),
  entry(
    'kitchen',
    'Kitchens',
    'profile',
    true,
    ['kitchen', 'kitchens', 'commercial kitchen', 'kitchen/cafeteria', 'cafeteria', 'canteen'],
    px(
      'The kitchen adds radiant heat to the weather. Limit time at ovens, grills and dishwashers, provide cool water and cool breaks, and pause non-essential hot service if anyone shows heat-illness signs.',
      'Wet kitchen floors and the delivery door are a slip risk. Keep entrances, mats and the back of house dry, and pause outdoor deliveries if the yard is flooding.',
      'Secure outdoor seating, canopies and signage. Pause terrace or rooftop service, and do not send a delivery out under unsecured loads.',
      'Slow delivery vehicles in the yard. Use a marked route and a spotter, and pause reversing at the dock if the driver cannot see.',
      'Limit time in cold rooms and at the open delivery door. Warm layers for yard and delivery staff, and check steps and ramps for ice.',
      'Stop terrace service, yard deliveries and any outdoor cooking. Move staff indoors, away from metal canopies and extract ducting.',
      'Grit delivery ramps, steps and the yard. Slow vehicles, and do not send riders or drivers out until the route is judged safe.',
      'Clear the delivery access and the yard. Check canopies and flat roofs for snow load, and delay non-essential deliveries.'
    )
  ),
  entry(
    'indoorGym',
    'Indoor gym',
    'profile',
    true,
    ['indoor gym', 'indoor gyms', 'gym', 'gyms'],
    px(
      'Check HVAC, air conditioning and ventilation in the gym and studios, and that temperature and humidity stay within the site limit. Keep hydration stations stocked, reduce the intensity of high-intensity classes, and watch staff and members, including anyone who commuted in the heat, for dizziness or confusion.',
      'Check the gym roof and skylights for leaks onto the floor. Dry the entrance, lay mats and put out wet-floor signs, and keep treadmills and other electrical kit away from water.',
      'Stay inside the gym. Secure entrance doors and external signage, and cancel roof or plant access until the wind drops.',
      'Light the entrance and the car park. Allow extra time for staff and members commuting, and slow any vehicle at the entrance.',
      'Grit the entrance and steps before opening. Confirm the heating is holding the gym, and watch staff and members who have commuted in the cold.',
      'If the gym has a roof or skylights, stop the class and move people clear of the glazed roof when lightning is close. On a power cut, use emergency lighting, and do not restart electrical equipment until it is checked.',
      'Grit the entrance, steps and car park. Dry water tracked into the gym, and keep mats and wet-floor signs at the door.',
      'Clear and grit the way in. Check the gym roof and skylights for snow load, and allow extra time for staff and members commuting.'
    )
  ),
  entry(
    'indoorPool',
    'Indoor pool',
    'profile',
    true,
    ['indoor pool', 'indoor pools', 'swimming pool', 'swimming pools', 'pool hall'],
    px(
      'Check pool-hall ventilation so humidity stays within the site limit and chlorine is not off-gassing into the hall. Check plant-room and chemical-storage temperatures, keep water available for lifeguards and teachers, and shorten sessions if the hall will not cool.',
      'Pool decks and changing rooms are a slip risk when rain is tracked in or the roof leaks. Dry them, lay mats and put out signs. Keep electrical equipment and pool plant away from leaks, and check drainage so basements are not flooding.',
      'Secure doors, signage and roof plant. Do not send anyone onto the pool roof or a plant deck while the wind holds, and keep the hall closed to the weather.',
      'Light the entrance, the car park and the route from the changing room. Slow vehicles at the entrance, and allow extra time for staff commuting.',
      'Grit entrances and the route from the car park. Watch lifeguards and teachers after a cold commute, and confirm plant-room heating so chemicals and pipework are not left at an unsafe temperature.',
      'If the pool hall has a roof or skylights, evacuate the pool when lightning is close or an electrical fault is suspected. Use emergency lighting if the power fails, keep people out of the water until the supply is confirmed safe, and do not restart pool plant until it has been checked.',
      'Grit entrances, steps and the car park. Dry the changing-room floor and the pool surround where water is tracked in, and keep mats and signs down.',
      'Clear and grit the entrance and car park. Check the pool roof and skylights for snow load before anyone goes up, and confirm plant rooms are free of melt water.'
    )
  ),
  entry(
    'indoorCourt',
    'Indoor court',
    'profile',
    true,
    ['indoor court', 'indoor courts', 'sports hall', 'sports court'],
    px(
      'Check air conditioning and ventilation over the courts, and that temperature and humidity stay within the site limit. Keep hydration stations stocked, reduce the intensity of long sessions, and watch players and staff who have commuted in the heat.',
      'Check the court roof and skylights for leaks onto the playing surface. Dry entrances and changing rooms, lay mats and put out wet-floor signs, and keep electrical equipment away from water.',
      'Keep play indoors. Secure doors and external signage, and do not open roof access while the wind holds.',
      'Light entrances and the car park. Allow extra time for players and staff commuting, and slow vehicles at the entrance.',
      'Grit entrances and steps before sessions. Confirm the court heating is holding, and watch people who have commuted in the cold.',
      'If the court has a roof or skylights, or the power fails, stop play and move people off the court. Use emergency lighting, and do not restart court equipment until the supply is checked.',
      'Grit the entrance, steps and car park. Dry water tracked onto the court surround, and keep mats and signs at the door.',
      'Clear and grit the way in. Check the court roof and skylights for snow load, and allow extra time for players and staff commuting.'
    )
  ),
  // Not the Warehousing & Logistics industry. A fitness estate's warehouse is
  // a building with no air conditioning, a dock and forklifts. The industry
  // label still matches an organisation whose work is logistics. The bare word
  // "warehouse" used to do that too, and a site tagged Warehouse then received
  // the wrong paragraph.
  entry(
    'facilityWarehouse',
    'Warehouse',
    'profile',
    true,
    ['warehouses'],
    px(
      'These buildings often have no air conditioning. Check ventilation, limit time on loading bays and in the yard, and enforce rest breaks and water for manual handling and forklift operators. Watch for heat illness, including staff who commuted in the heat.',
      'Check the dock and the yard for flooding, and move stock off the floor and away from roof leaks. Do not run a forklift on a wet floor. Slow delivery vehicles, and stop reversing on a flooded dock unless a spotter can see.',
      'Close the dock doors. Secure loose pallets and yard items, and stop work on the loading bay and any roof access while the wind holds.',
      'Slow forklifts and delivery vehicles. Light the dock and the yard, and use a spotter for reversing when the driver cannot see.',
      'Limit time on the open dock. Warm breaks for forklift operators and anyone manual handling, and check the dock and yard for ice before vehicles move.',
      'Close the dock and stop yard and roof work. If the power fails, use emergency lighting, leave forklifts parked, and do not restart charging or plant until it is checked.',
      'Grit the dock approach and the yard. Do not run a forklift on ice, and slow delivery vehicles on the way in.',
      'Clear the dock approach and protect stock from melt water. Check the roof for snow load before anyone goes up, and slow delivery vehicles.'
    )
  ),
  entry(
    'outdoorGym',
    'Gyms with outdoor sessions',
    'profile',
    true,
    ['outdoor session', 'outdoor sessions', 'outdoor class', 'outdoor classes'],
    px(
      'Shorten or move the outdoor session indoors, and schedule it for the cooler hours. Water at the session, a lower intensity, and stop the class if anyone is dizzy, cramping or confused.',
      'Do not continue an outdoor session, pitch class or poolside class in the rain. Move it indoors, and keep the entrance and changing-room floor dry for people coming in.',
      'Cancel the outdoor session. Secure goals, sails and loose kit, and do not train beside trees or temporary structures.',
      'Postpone the outdoor session. Do not send a running or cycling group out when they cannot see the route.',
      'Cut the outdoor session short, add warm layers and a sheltered break, and watch for shivering before anyone is left outside.',
      'Stop the outdoor session and any pool use at the first thunder. Indoors until the storm has passed.',
      'Cancel the outdoor session. Close icy courts, paths and steps, and grit the way in.',
      'Cancel the outdoor session. Clear the entrance, and check shade structures and temporary covers for snow load before anyone uses them.'
    )
  ),
  entry(
    'outdoor',
    'Outdoor work',
    'task',
    true,
    ['outdoor work', 'outdoor', 'open air', 'yard work'],
    px(
      'Move heavy outdoor tasks to the cooler hours. Shade, cool water and enforced rest, and stop the job if anyone shows heat-illness signs.',
      'Stop outdoor tasks that cannot be done on wet ground, including work at height and hot work. Keep tools and cables out of standing water, and check drainage.',
      'Stop outdoor lifting and work at height. Secure loose materials and temporary covers, and keep people clear of edges.',
      'Slow vehicles and plant. Lights and high-visibility clothing on, and a spotter wherever the operator cannot see.',
      'Limit time on the exposed task. Warm clothing and warm breaks, and watch for numbness or shivering.',
      'Stop outdoor work. Move people indoors or into a hard-topped vehicle, clear of tall plant and open ground, until the storm has passed.',
      'Grit or close icy routes. Slow vehicles, and stop work at height where the surface is slippery.',
      'Clear and grit the access. Check temporary covers and roofs for snow load before use, and delay non-essential outdoor work.'
    )
  ),
  entry(
    'height',
    'Working at height',
    'task',
    true,
    [
      'working at height',
      'work at height',
      'height work',
      'scaffolding',
      'scaffold',
      'fragile roof',
    ],
    px(
      'Schedule roof, scaffold and mast work for the cooler hours. Provide shade and water where people are working, and bring anyone with heat-illness signs down at once.',
      'Stop work at height when surfaces are wet. Do not climb wet ladders or open scaffolding.',
      'Stop scaffolding, roof, mast and crane work. Secure boards and sheeting, and clear the area below.',
      'Stop lifting and work at an edge when the operator or the ground crew cannot see.',
      'Shorten exposed shifts on roofs and scaffolds. Keep harnesses and gloves dry, and bring people down if they are shivering.',
      'Get everyone off scaffolding, roofs and masts, and well clear of them. Resume only when the storm has passed.',
      'Stop work at height. Do not use icy ladders, scaffold stairs or roofs.',
      'Do not go onto a roof or scaffold until the snow load is checked and the access is cleared.'
    )
  ),
  entry(
    'hotwork',
    'Hot work',
    'task',
    true,
    ['hot work', 'hotwork', 'hot works', 'welding', 'grinding'],
    px(
      'Do welding, cutting and grinding in the cooler hours, with shade, water, and a fire watch who is also watching for heat illness. Stop if anyone is confused or stops sweating.',
      'Stop outdoor hot work. Keep gas sets, leads and the fire watch off wet ground, and do not weld where water is running into a tray or pit.',
      'Stop outdoor hot work. Wind carries sparks. Secure screens and cylinders before anyone leaves the job.',
      'Stop hot work where the fire watch cannot see the spark zone.',
      'Keep the fire watch and the welder warm enough to stay alert. Check that cylinders and hoses are not iced over.',
      'Stop hot work and move clear of cylinders, cranes and open ground. Resume only when the storm has passed.',
      'Stop hot work at height or on icy ground. Keep the escape route gritted.',
      'Clear the work area and the escape route. Do not carry out hot work under a snow-loaded temporary roof.'
    )
  ),
  entry(
    'driving',
    'Deliveries and driving',
    'task',
    true,
    [
      'deliveries',
      'delivery',
      'driving',
      'driver',
      'traffic',
      'motorized vehicle operation',
      'motorised vehicle operation',
    ],
    px(
      'Plan routes away from the hottest hours. Cool the cab before a shift, carry water, and do not leave anyone in a parked vehicle.',
      'Slow down and increase the following distance. Postpone non-essential trips if standing water covers the yard or the route, and check brakes and lights before leaving.',
      'Keep high-sided vehicles and motorcycles in the yard when gusts make them hard to hold. Secure every load before departure.',
      'Slow right down or stop. Lights on, and no reversing in the yard without a spotter who can see.',
      'Check tyres, lights and wipers before departure. Carry warm clothing, and watch drivers for shivering after a long exposed unload.',
      'Do not load or unload in the open during a storm. Drivers stay in the cab or go indoors, and stay clear of a high vehicle on open ground.',
      'Delay departures until the yard and the route are gritted or judged safe. Slow plant in the yard.',
      'Clear and grit the yard and the dock. Clear vehicle roofs and racks, and delay non-essential runs.'
    )
  ),
  entry(
    'electrical',
    'Electrical work',
    'task',
    true,
    ['electrical work', 'electrical', 'live electrical', 'buried cables'],
    px(
      'Schedule outdoor and plant-room electrical work for the cooler hours. Do not add extra layers of electrical PPE without a rest plan. Keep drinking water at the point of work, and stop if anyone is dizzy or confused.',
      'Stop live and outdoor electrical work on wet ground. Keep panels, leads and tools under cover, and do not stand in water to operate equipment.',
      'Stop work on poles, rooftop plant and external cable runs. Secure ladders and leads, and keep people clear of overhead lines.',
      'Pause overhead-line and roadside electrical work when the operator cannot see traffic. Use a spotter, and keep high-visibility clothing on.',
      'Limit time on exposed external plant. Keep gloves dry, and check access stairs and plant rooms for ice before climbing.',
      'Stop all outdoor and rooftop electrical work at once. Keep clear of lines, masts, substations and open ground, and resume only when the storm has passed.',
      'Do not climb icy poles, towers or external stairs. Grit the access, and stop work at height until surfaces are clear.',
      'Clear access to substations and plant rooms. Check roofs and cable trays for snow load before anyone goes up, and delay non-essential external work.'
    )
  ),
  entry(
    'confined',
    'Confined space',
    'task',
    true,
    ['confined space', 'confined space work'],
    px(
      'Postpone non-essential entry. Heat builds inside a confined space, so limit time in the space, keep water with the attendant, and pull the entrant if they are dizzy, cramping or confused.',
      'Do not enter if water can flood the space. Check drainage and the atmosphere before entry, and keep the attendant out of standing water.',
      'Secure the attendant area and any tripod or davit. Stop the entry if wind makes the rescue gear or the access unsafe.',
      'Postpone the entry if the attendant cannot see the entrance or the rescue route.',
      'Limit time in a cold space. Dry gloves, a warm recovery area for the entrant, and watch for shivering after exit.',
      'Stop the entry and move the attendant clear of the opening, tripods and open ground. Resume only when the storm has passed.',
      'Do not use an icy access or ladder into the space. Grit the approach, and keep the rescue route clear.',
      'Clear the approach and the rescue route. Check any temporary cover over the opening for snow load before entry.'
    )
  ),
  entry(
    'excavation',
    'Excavation',
    'task',
    true,
    ['excavation', 'excavations'],
    px(
      'Schedule heavy digging and work in the excavation for the cooler hours. Shade and water at the top and for anyone in the excavation, and watch for heat illness.',
      'Stop work if water is undermining the sides or pooling in the excavation. Check drainage and the batter before anyone goes in, and keep pumps and leads out of standing water.',
      'Stop lifting over the excavation. Secure covers and stop work at the edge if people cannot stand clear of it.',
      'Stop plant at the excavation if the operator cannot see people. A spotter, lights, and no reversing blind.',
      'Limit time in the excavation and on the exposed edge. Warm breaks, and check ladders and the edge for ice.',
      'Get everyone out of the excavation and clear of plant and open ground. Resume only when the storm has passed.',
      'Do not use icy ladders or edges. Grit the approach, and stop plant until the ground is judged safe.',
      'Clear the approach. Check covers and temporary supports for snow load, and do not enter until the sides and the access are checked.'
    )
  ),
  entry(
    'hazload',
    'Hazardous loading',
    'task',
    true,
    ['loading and unloading of hazardous material', 'hazardous loading'],
    px(
      'Limit time on an exposed load or in heavy chemical PPE. Cool water, shade and a rest plan, and stop the lift if anyone shows heat-illness signs.',
      'Stop loading if the vehicle, the dock or the containment is standing in water. Keep electrical equipment dry, and watch for product washed out of a bund or a tray.',
      'Stop the lift. Secure containers, covers and the load, and keep people clear of the downwind side.',
      'Stop the lift and reversing if the operator cannot see. A spotter, and high-visibility clothing on everyone on the dock.',
      'Limit time on the exposed dock. Dry gloves, warm breaks, and check the dock and the vehicle steps for ice.',
      'Stop loading and move clear of the vehicle, the load and open ground. Resume only when the storm has passed.',
      'Grit the dock and the yard. Slow vehicles, and do not climb an icy trailer or container.',
      'Clear the dock and the yard. Check vehicle roofs are clear, and delay the load if the route out is not safe.'
    )
  ),
]

// The site type asked for on every new site, for every organisation. "Other"
// has no built-in sentence: the mail uses the organisation's activities, then
// the general paragraph, unless an admin has written one. "Warehouse" is this
// list, not the Warehousing & Logistics industry.
export const SITE_TYPES = [
  { label: 'Office', id: 'office' },
  { label: 'Indoor gym', id: 'indoorGym' },
  { label: 'Indoor pool', id: 'indoorPool' },
  { label: 'Indoor court', id: 'indoorCourt' },
  { label: 'Warehouse', id: 'facilityWarehouse' },
  { label: 'Kitchen/Cafeteria', id: 'kitchen' },
  { label: 'Retail store', id: 'retail' },
  { label: 'Outdoor site/Construction', id: 'construction' },
  { label: 'Manufacturing/Plant', id: 'manufacturing' },
  { label: 'Other', id: '' },
]

export const FACILITY_LABELS = SITE_TYPES.map((type) => type.label)

const byId = new Map(CATALOG.map((item) => [item.id, item]))
const TASKS = new Set(CATALOG.filter((item) => item.kind === 'task').map((item) => item.id))
const PROFILES = new Set(CATALOG.filter((item) => item.kind === 'profile').map((item) => item.id))

export function normActivity(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function matchesPhrase(text, alias) {
  const n = normActivity(text)
  const a = normActivity(alias)
  if (!n || !a) return false
  if (n === a) return true
  const padded = ` ${n} `
  if (padded.includes(` ${a} `)) return true
  // "electrical" inside "electricals", and not "ice" inside "licence".
  if (a.length >= 8) return n.split(' ').some((word) => word.startsWith(a))
  return false
}

function namesOf(item) {
  return [item.label, ...item.aliases]
}

function matchKind(text, kind, loose) {
  const hits = []
  for (const item of CATALOG) {
    if (item.kind !== kind) continue
    let matched = false
    for (const name of namesOf(item)) {
      const exact = normActivity(name) === normActivity(text)
      if (exact || (loose && matchesPhrase(text, name))) {
        matched = true
        break
      }
    }
    if (matched) hits.push(item.id)
  }
  return hits
}

/**
 * Whole-string profile matches win alone. "Outdoor sessions" is the outdoor
 * session profile, not an indoor gym and not generic outdoor work, and
 * "inspect the site office" is not an office.
 * Loose matching is only for a field the org has already called a site type.
 */
export function classifySignal(text, { looseProfile = false } = {}) {
  const raw = String(text || '').trim()
  if (!raw) return { profiles: [], tasks: [] }
  const exactProfiles = matchKind(raw, 'profile', false)
  if (exactProfiles.length) return { profiles: exactProfiles, tasks: [] }
  return {
    profiles: looseProfile ? matchKind(raw, 'profile', true) : [],
    tasks: matchKind(raw, 'task', true),
  }
}

function unique(list) {
  const out = []
  const seen = new Set()
  for (const item of list || []) {
    if (!item || seen.has(item)) continue
    seen.add(item)
    out.push(item)
  }
  return out
}

function classifyList(list) {
  const profiles = []
  const tasks = []
  const custom = []
  for (const raw of list || []) {
    const text = String(raw || '')
      .trim()
      .replace(/\s+/g, ' ')
    if (!text) continue
    const found = classifySignal(text, { looseProfile: false })
    if (found.profiles.length || found.tasks.length) {
      profiles.push(...found.profiles)
      tasks.push(...found.tasks)
    } else custom.push(text.slice(0, MAX_LABEL))
  }
  return { profiles: unique(profiles), tasks: unique(tasks), custom: unique(custom) }
}

function dropParents({ profiles, tasks, custom }) {
  const drop = new Set()
  for (const id of [...profiles, ...tasks]) if (PARENT[id]) drop.add(PARENT[id])
  return {
    profiles: profiles.filter((id) => !drop.has(id)),
    tasks: tasks.filter((id) => !drop.has(id)),
    custom,
  }
}

function byRank(order) {
  const rank = new Map(order.map((id, index) => [id, index]))
  return (a, b) => (rank.get(a) ?? 999) - (rank.get(b) ?? 999) || String(a).localeCompare(String(b))
}

/**
 * Flat activity ids for one site: tasks, then one place, then a custom label
 * the admin typed that the catalog does not know. `siteProfileIds` and
 * `siteTaskIds` are already catalog ids. Activity-type arrays are labels.
 */
export function chooseActivities({
  orgActivityTypes = [],
  siteActivityTypes = [],
  siteProfileIds = [],
  siteTaskIds = [],
} = {}) {
  const own = Array.isArray(siteActivityTypes) && siteActivityTypes.length
  const base = classifyList(own ? siteActivityTypes : orgActivityTypes)
  const profiles = siteProfileIds.length ? unique(siteProfileIds) : base.profiles
  const tasks = unique([...(siteTaskIds || []), ...base.tasks])
  const custom = base.custom
  const dropped = dropParents({ profiles, tasks, custom })
  return [
    ...dropped.tasks.sort(byRank(TASK_ORDER)),
    ...dropped.profiles.sort(byRank(PROFILE_ORDER)),
    ...dropped.custom.sort((a, b) => a.localeCompare(b)),
  ]
}

function cleanLine(value) {
  if (typeof value !== 'string') return ''
  const text = value.replace(/\s+/g, ' ').trim()
  return text ? text.slice(0, MAX_TEXT) : ''
}

/** Stored overrides, stripped to plain text on the known alert keys. */
export function normalizeOverrides(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out = {}
  for (const [activity, alerts] of Object.entries(raw)) {
    const label = String(activity || '')
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, MAX_LABEL)
    if (!label || !alerts || typeof alerts !== 'object' || Array.isArray(alerts)) continue
    const row = {}
    for (const key of ALERT_KEYS) {
      const text = cleanLine(alerts[key])
      if (text) row[key] = text
    }
    if (Object.keys(row).length) out[label] = row
  }
  return out
}

function cleanLabel(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, MAX_LABEL)
}

/**
 * The label stored on site.facility. A general site type wins, then a label
 * the organisation has configured, then a catalog entry's own site-type name.
 * An unknown custom label is kept so a type added in Org Settings still
 * round-trips; the import refuses one the organisation has not configured.
 */
export function canonicalFacility(value, extraLabels = []) {
  const text = cleanLabel(value)
  if (!text) return ''
  const general = SITE_TYPES.find((type) => normActivity(type.label) === normActivity(text))
  if (general) return general.label
  const extra = (extraLabels || []).find((label) => normActivity(label) === normActivity(text))
  if (extra) return cleanLabel(extra)
  const entry = entryForLabel(text)
  if (entry) {
    const mapped = SITE_TYPES.find((type) => type.id && type.id === entry.id)
    if (mapped) return mapped.label
    return entry.label
  }
  return text
}

/** General site types, then this organisation's activities that are not already one of them. */
export function siteTypeOptions(activityTypes = []) {
  const general = SITE_TYPES.map((type) => type.label)
  const seen = new Set(general.map((label) => normActivity(label)))
  const extra = []
  for (const raw of activityTypes || []) {
    const text = cleanLabel(raw)
    if (!text || seen.has(normActivity(text))) continue
    const canonical = canonicalFacility(text)
    if (general.some((label) => normActivity(label) === normActivity(canonical))) continue
    seen.add(normActivity(text))
    extra.push(text)
  }
  return { general, extra }
}

export function entryForLabel(raw) {
  const n = normActivity(raw)
  if (!n) return null
  const exact =
    CATALOG.find((item) => normActivity(item.label) === n) ||
    CATALOG.find((item) => item.aliases.some((alias) => normActivity(alias) === n))
  if (exact) return exact
  // "Night deliveries" is the deliveries activity, so the editor and the mail
  // share one row. A HIRA title is classified separately and does not come
  // through here.
  const found = classifySignal(raw, { looseProfile: true })
  const id = found.tasks[0] || found.profiles[0]
  return id ? byId.get(id) : null
}

export function builtInPrecaution(label, alertKey) {
  return entryForLabel(label)?.precautions?.[alertKey] || ''
}

/** Drop blanks and sentences that only repeat the built-in default. */
export function packOverrides(raw) {
  const normalized = normalizeOverrides(raw)
  const out = {}
  for (const [label, row] of Object.entries(normalized)) {
    const kept = {}
    for (const [alert, text] of Object.entries(row)) {
      if (builtInPrecaution(label, alert) === text) continue
      kept[alert] = text
    }
    if (Object.keys(kept).length) out[label] = kept
  }
  return out
}

function lineFor(id, alertKey, overrides) {
  const entry = byId.get(id)
  const label = entry?.label || id
  // The site-type editor stores "Office", the catalog row is "Office /
  // Administration". Either key is the same sentence.
  const keys = []
  if (entry) {
    for (const type of SITE_TYPES) if (type.id === entry.id) keys.push(type.label)
    keys.push(entry.label)
  } else keys.push(id)
  for (const key of keys) {
    const text = overrides?.[key]?.[alertKey]
    if (text) return { label: entry?.label || key, text }
  }
  const builtIn = entry?.precautions?.[alertKey]
  if (builtIn) return { label, text: builtIn }
  return null
}

/**
 * The cell text for one alert. No recorded activity, or none of them has a
 * sentence for this alert, returns the general paragraph.
 */
export function precautionText(alertKey, activityIds, overrides = {}) {
  const key = Object.prototype.hasOwnProperty.call(GENERIC_PRECAUTIONS, alertKey)
    ? alertKey
    : 'other'
  const list = Array.isArray(activityIds) ? activityIds : []
  const tasks = list.filter((id) => TASKS.has(id))
  const profiles = list.filter((id) => PROFILES.has(id))
  const custom = list.filter((id) => !TASKS.has(id) && !PROFILES.has(id))
  const picked = []
  const roomForTasks = profiles.length ? MAX_TASKS_WITH_PROFILE : MAX_LINES
  for (const id of tasks) {
    if (picked.length >= roomForTasks) break
    picked.push(id)
  }
  if (profiles[0] && picked.length < MAX_LINES) picked.push(profiles[0])
  for (const id of custom) {
    if (picked.length >= MAX_LINES) break
    picked.push(id)
  }
  for (const id of tasks) {
    if (picked.length >= MAX_LINES) break
    if (!picked.includes(id)) picked.push(id)
  }
  const lines = []
  for (const id of picked) {
    const line = lineFor(id, key, overrides)
    if (line) lines.push(line)
  }
  if (!lines.length) return GENERIC_PRECAUTIONS[key]
  if (lines.length === 1) return lines[0].text
  return lines.map((line) => `${line.label}: ${line.text}`).join(' ')
}

/**
 * Rows for the settings screen. Selected activities open first. Task and
 * extra place entries stay listed when they are not selected, because a
 * permit or a HIRA title can still bring them into the mail.
 */
export function editorRows(activityTypes = []) {
  const selected = []
  const seen = new Set()
  for (const raw of activityTypes || []) {
    const text = String(raw || '')
      .trim()
      .replace(/\s+/g, ' ')
    if (!text) continue
    const entry = entryForLabel(text)
    const label = (entry?.label || text).slice(0, MAX_LABEL)
    if (seen.has(label)) continue
    seen.add(label)
    selected.push({ label, entry, selected: true })
  }
  const extra = CATALOG.filter((item) => item.extra && !seen.has(item.label)).map((item) => ({
    label: item.label,
    entry: item,
    selected: false,
  }))
  return { selected, extra }
}

/** One editor row per general site type. "Other" has no built-in sentence. */
export function siteTypeRows() {
  return SITE_TYPES.map((type) => ({
    label: type.label,
    entry: type.id ? byId.get(type.id) || null : null,
    selected: true,
  }))
}

function emptyBag() {
  return { profile: [], task: [], siteActivityTypes: [], facility: '' }
}

function slot(map, key) {
  if (!key) return null
  if (!map.has(key)) map.set(key, emptyBag())
  return map.get(key)
}

function addId(mapById, mapByName, siteId, name, field, value) {
  if (!value) return
  for (const bag of [slot(mapById, siteId), slot(mapByName, normActivity(name))]) {
    if (bag) bag[field].push(value)
  }
}

function normKey(value) {
  return normActivity(value).replace(/ /g, '_')
}

/**
 * Catalog ids (and raw site activity labels) keyed by site id and by
 * normalised site name. Permits written before siteId was stored match on
 * the name only; both are merged at read so a later id does not hide them.
 */
export function indexSiteSignals({ sites = [], assessments = [], permits = [] } = {}) {
  const bySiteId = new Map()
  const byName = new Map()
  for (const site of sites || []) {
    if (!site || site.deletedAt) continue
    const id = site.id || ''
    const name = site.name || ''
    for (const activity of site.activityTypes || []) {
      const text = typeof activity === 'string' ? activity.trim() : ''
      if (text) addId(bySiteId, byName, id, name, 'siteActivityTypes', text)
    }
    // The site type frames the mail. Stored as a label; "Other" is recorded
    // too so the reader can tell "not chosen" from "chosen, use the fallback".
    const facility = canonicalFacility(site.facility)
    if (facility) {
      for (const bag of [slot(bySiteId, id), slot(byName, normActivity(name))]) {
        if (bag && !bag.facility) bag.facility = facility
      }
    }
    const attributes = site.attributes && typeof site.attributes === 'object' ? site.attributes : {}
    for (const [key, value] of Object.entries(attributes)) {
      if (typeof value !== 'string' || !value.trim()) continue
      const loose = TYPE_KEYS.has(normKey(key))
      // A floor named "Office" must not reclassify the site. Loose word
      // matching stays on keys the org has already called a type. Any other
      // attribute counts only when its whole value is a catalog label.
      const labelHit = CATALOG.some((item) => normActivity(item.label) === normActivity(value))
      if (!loose && !labelHit) continue
      const found = loose
        ? classifySignal(value, { looseProfile: true })
        : classifySignal(value, { looseProfile: false })
      for (const profileId of found.profiles)
        addId(bySiteId, byName, id, name, 'profile', profileId)
      for (const taskId of found.tasks) addId(bySiteId, byName, id, name, 'task', taskId)
    }
  }
  for (const assessment of assessments || []) {
    if (!assessment || assessment.kind === 'baseline') continue
    const id = assessment.siteId || ''
    const name = assessment.siteName || ''
    if (!id && !normActivity(name)) continue
    const bits = []
    for (const activity of assessment.activities || []) {
      if (activity?.title) bits.push(activity.title)
      for (const hazard of activity?.hazards || []) {
        if (hazard?.hazardType) bits.push(hazard.hazardType)
        if (hazard?.hazardCategory) bits.push(hazard.hazardCategory)
      }
    }
    for (const bit of bits) {
      const found = classifySignal(bit, { looseProfile: false })
      for (const profileId of found.profiles)
        addId(bySiteId, byName, id, name, 'profile', profileId)
      for (const taskId of found.tasks) addId(bySiteId, byName, id, name, 'task', taskId)
    }
  }
  for (const permit of permits || []) {
    if (!permit) continue
    const id = permit.siteId || ''
    const name = permit.site || permit.siteName || ''
    const bits = [permit.typeOfWork, ...(Array.isArray(permit.hazards) ? permit.hazards : [])]
    for (const bit of bits) {
      if (typeof bit !== 'string') continue
      const found = classifySignal(bit, { looseProfile: false })
      for (const profileId of found.profiles)
        addId(bySiteId, byName, id, name, 'profile', profileId)
      for (const taskId of found.tasks) addId(bySiteId, byName, id, name, 'task', taskId)
    }
  }
  return { bySiteId, byName }
}

export function signalsForArea(index, area) {
  const byId = area?.siteId ? index?.bySiteId?.get(area.siteId) : null
  const byName = index?.byName?.get(normActivity(area?.name))
  return {
    profile: unique([...(byId?.profile || []), ...(byName?.profile || [])]),
    task: unique([...(byId?.task || []), ...(byName?.task || [])]),
    siteActivityTypes: unique([
      ...(byId?.siteActivityTypes || []),
      ...(byName?.siteActivityTypes || []),
    ]),
    facility: byId?.facility || byName?.facility || '',
  }
}

function orgActivities(org, signals) {
  return chooseActivities({
    orgActivityTypes: org?.activityTypes,
    siteActivityTypes: signals.siteActivityTypes,
    siteProfileIds: signals.profile,
    siteTaskIds: signals.task,
  })
}

export function activitiesForArea(org, index, area) {
  const signals = signalsForArea(index, area)
  const facility = signals.facility
  // A chosen site type replaces the organisation profile. "Other", and a
  // custom label with no catalog entry, leave that choice to resolvePrecaution
  // so a missing sentence can still fall back.
  if (facility && normActivity(facility) !== 'other' && entryForLabel(facility)) {
    return chooseActivities({
      orgActivityTypes: [facility],
      siteTaskIds: signals.task,
    })
  }
  return orgActivities(org, signals)
}

/**
 * Site type, then the organisation's activities, then the general paragraph
 * (the last of those is what precautionText returns when the id list is empty
 * or the custom label has no sentence).
 */
export function resolvePrecaution(alertKey, org, index, area, overrides = {}) {
  const signals = signalsForArea(index, area)
  const facility = signals.facility
  if (facility && normActivity(facility) === 'other') {
    const written = overrides?.Other?.[alertKey]
    if (written) return written
    return precautionText(alertKey, orgActivities(org, signals), overrides)
  }
  if (facility && !entryForLabel(facility)) {
    const written = overrides?.[facility]?.[alertKey]
    if (written) {
      const ids = chooseActivities({
        orgActivityTypes: [facility],
        siteTaskIds: signals.task,
      })
      return precautionText(alertKey, ids, overrides)
    }
    return precautionText(alertKey, orgActivities(org, signals), overrides)
  }
  return precautionText(alertKey, activitiesForArea(org, index, area), overrides)
}

async function readCapped(db, path, fields, cap) {
  let query = db.collection(path)
  if (typeof query.select === 'function' && fields?.length) query = query.select(...fields)
  if (typeof query.limit === 'function') query = query.limit(cap)
  const snap = await query.get()
  return (snap?.docs || []).map((docSnap) => ({
    id: docSnap.id,
    ...(typeof docSnap.data === 'function' ? docSnap.data() || {} : {}),
  }))
}

/**
 * `(alertKey, area) => sentence` for one org. A failed HIRA or permit read
 * leaves the org-level activities in place and still sends the mail: losing
 * the site detail is a blunter sentence, and losing the mail is a missed
 * warning. The org document itself failing is the same choice.
 */
export async function loadPrecautionFor(db, orgId, sites, log) {
  let org = {}
  try {
    const snap = await db.doc(`organizations/${orgId}`).get()
    org = snap?.exists ? snap.data() || {} : {}
  } catch (err) {
    log?.error?.('weather digest org profile read failed', {
      orgId,
      error: err?.message || 'org-read-failed',
    })
  }
  const overrides = normalizeOverrides(org.weatherPrecautions)
  let index = indexSiteSignals({ sites })
  try {
    const [assessments, permits] = await Promise.all([
      readCapped(
        db,
        `organizations/${orgId}/assessments`,
        ['siteId', 'siteName', 'kind', 'activities'],
        ASSESSMENT_CAP
      ),
      readCapped(
        db,
        `organizations/${orgId}/permits`,
        ['siteId', 'site', 'typeOfWork', 'hazards'],
        PERMIT_CAP
      ),
    ])
    index = indexSiteSignals({ sites, assessments, permits })
    if (assessments.length >= ASSESSMENT_CAP || permits.length >= PERMIT_CAP) {
      log?.info?.('weather digest activity read hit its cap', {
        orgId,
        assessments: assessments.length,
        permits: permits.length,
      })
    }
  } catch (err) {
    log?.error?.('weather digest activity read failed', {
      orgId,
      error: err?.message || 'activity-read-failed',
    })
  }
  return (alertKey, area) => resolvePrecaution(alertKey, org, index, area, overrides)
}
