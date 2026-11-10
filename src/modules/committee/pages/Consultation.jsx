import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useLocation } from 'react-router-dom';
import * as XLSX from 'xlsx';
import { jsonToSheet } from '../../../shared/lib/sheet';
import toast from 'react-hot-toast';
import { toastCaught } from '../../../shared/lib/toastCaught';
import {
  PieChart, Pie, Cell, BarChart, Bar, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts'
import ChartFrame from '../../../shared/ui/ChartFrame';
// Chart icons use lucide's Chart* names — PieChart/AreaChart are recharts components here.
import {
    AlertCircle, ArrowLeft, Calendar, ChartArea, ChartColumn, ChartPie, CheckCircle2, ChevronLeft,
    ChevronRight, ClipboardList, Clock, Eye, FileSpreadsheet, FolderOpen, Handshake, ListChecks,
    ListOrdered, ListTodo, Loader2, MapPin, MessagesSquare, Pencil, Plus, Printer, Save, Target,
    Trash2, Users,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import SiteScopePicker from '../../../shared/org/SiteScopePicker';
import DeptPersonPicker from '../../../shared/org/DeptPersonPicker';
import ActionOwnerField from '../components/ActionOwnerField';
import { orgDepartments } from '../../../shared/auth/access';
import {
    actionOwnerDisplay,
    actionOwnerKind,
    actionOwnerRecord,
    actionOwnerText,
    canUpdateActionStatus,
    meetingExportSheets,
} from '../lib/actionOwner';
import { moduleLevelKeys, SITE_LEVEL_KEY } from '../../../shared/org/scopeConfig';
import { Pager } from '../../../shared/ui';
import { reserveDocId } from '../../../shared/docId/reserve';
import { usePagination } from '../../../shared/ui/usePagination';
import Logo from '../components/Logo';
import MeetingMinutesDoc from '../components/MeetingMinutesDoc';
import LogoLoader from '../components/LogoLoader';
import { ModuleMark } from '../../../shared/ui';
import { isFutureDate, todayISO, isOverdueDate, toISODate } from '../../../shared/lib/dates';
import { sameCentreId } from '../../../shared/org/centreId';
import {
    subscribeSites,
    subscribeOrgUsers,
    subscribeConsultations,
    addConsultation,
    updateConsultation,
    deleteConsultation,
} from '../lib/data';

const MEETING_TYPES = [
    "HSE Committee Meeting",
    "Risk Assessment Review",
    "Policy Review",
    "Emergency Planning",
    "Management of Change",
    "Management Review"
];

const STATUS_COLORS = { 'Open': '#ef4444', 'In Progress': '#facc15', 'Closed': '#22c55e' };
const TYPE_COLORS = ['#16a34a', '#22c55e', '#4ade80', '#0ea5e9', '#6366f1', '#f59e0b'];

// ==========================================
// SUB-COMPONENT: MEETING DETAIL MODAL
// ==========================================
const MeetingDetailModal = ({ meeting, siteLabel, onClose, onUpdateStatus, onPrint, session, permissions }) => {
    if (!meeting) return null;

    const canEditStatus = (row) => canUpdateActionStatus(row, session, {
        elevated: session?.role === 'admin',
        canEditMeeting: permissions.canEditCreate && actionOwnerKind(row) !== 'department',
    });

    return (
        <div className="fixed inset-0 bg-black/55 backdrop-blur-sm flex items-center justify-center z-50 p-4 overflow-y-auto animate-in fade-in zoom-in-95 duration-300 print:hidden">
            <div className="bg-surface border border-surface-200 w-full max-w-5xl rounded-3xl flex flex-col shadow-2xl relative min-h-[50vh] max-h-[90vh] overflow-hidden">
                <div className="p-6 border-b border-surface-200 flex justify-between items-center bg-surface-100">
                    <div>
                        <h1 className="text-2xl font-bold uppercase text-green-700 flex items-center gap-3"><Handshake size={20} /> Minutes of Meeting</h1>
                        <p className="text-sm text-ink-500 mt-1 font-mono">Ref: {meeting.docId || meeting.id}</p>
                    </div>
                    <div className="text-right text-xs text-ink-500 font-bold uppercase tracking-widest bg-surface p-3 rounded-xl border border-surface-200">
                        <p className="mb-1 text-green-700"><Calendar size={16} className="inline mr-1" /> {meeting.date}</p>
                        <p><MapPin size={16} className="inline mr-1" /> Site: {siteLabel || meeting.siteId}</p>
                    </div>
                </div>

                <div className="flex-1 overflow-y-auto p-8 custom-scroll space-y-6">
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm bg-surface p-6 rounded-2xl border border-surface-200/70">
                        <div><span className="text-ink-400 text-[10px] uppercase block tracking-widest mb-1">Type</span><span className="font-bold text-ink-900">{meeting.type || 'Consultation'}</span></div>
                        <div><span className="text-ink-400 text-[10px] uppercase block tracking-widest mb-1">Date</span><span className="font-bold text-ink-900">{meeting.date}</span></div>
                        <div><span className="text-ink-400 text-[10px] uppercase block tracking-widest mb-1">Time</span><span className="font-bold text-ink-900">{meeting.time || 'N/A'}</span></div>
                        <div><span className="text-ink-400 text-[10px] uppercase block tracking-widest mb-1">Logged By</span><span className="font-bold text-green-700">{meeting.createdBy}</span></div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <div className="flex flex-col">
                            <h3 className="text-xs uppercase text-green-700 font-bold mb-3 tracking-widest"><Target size={14} className="inline mr-2" />Subject / Agenda</h3>
                            <div className="bg-surface-100 p-4 rounded-xl border border-surface-200 text-sm flex-1 text-ink-900 font-medium leading-relaxed">{meeting.subject || meeting.agenda || 'N/A'}</div>
                        </div>
                        <div>
                            <h3 className="text-xs uppercase text-green-700 font-bold mb-3 tracking-widest"><Users size={14} className="inline mr-2" />Attendees</h3>
                            <div className="flex flex-wrap gap-2 bg-surface p-4 rounded-xl border border-surface-200/70 min-h-[80px]">
                                {(meeting.attendees || []).map((a, i) => (
                                    <span key={i} className="bg-surface-100 px-3 py-1.5 rounded-lg text-xs font-bold border border-surface-200 text-ink-900 shadow-sm">
                                        {a.name} <span className="text-ink-500 font-medium ml-1">({a.role})</span>
                                        {a.userId === 'External' && <span className="ml-2 text-[9px] text-purple-700 bg-purple-100 px-1.5 py-0.5 rounded font-bold uppercase tracking-widest border border-purple-500/30">EXT</span>}
                                    </span>
                                ))}
                                {(!meeting.attendees || meeting.attendees.length === 0) && <span className="text-ink-400 italic text-xs">No attendees recorded.</span>}
                            </div>
                        </div>
                    </div>

                    <div>
                        <h3 className="text-xs uppercase text-green-700 font-bold mb-3 tracking-widest"><ClipboardList size={14} className="inline mr-2" />Pre-Requisites / Inputs</h3>
                        <div className="bg-surface p-5 rounded-xl border border-surface-200/70 text-sm whitespace-pre-wrap text-ink-600 leading-relaxed min-h-[100px]">{meeting.preRequisites || 'None specified.'}</div>
                    </div>

                    <div>
                        <h3 className="text-xs uppercase text-green-700 font-bold mb-3 tracking-widest"><MessagesSquare size={14} className="inline mr-2" />Discussion Minutes</h3>
                        <div className="bg-surface p-5 rounded-xl border border-surface-200/70 text-sm whitespace-pre-wrap text-ink-900 leading-relaxed min-h-[150px]">{meeting.minutes || 'No minutes recorded.'}</div>
                    </div>

                    <div>
                        <h3 className="text-xs uppercase text-green-700 font-bold mb-4 border-b border-green-500/20 pb-2 tracking-widest"><ListTodo size={14} className="inline mr-2" />Action Plan (CAPA)</h3>
                        <div className="overflow-x-auto rounded-xl border border-surface-200 shadow-xl">
                            <table className="w-full text-left text-sm whitespace-nowrap">
                                <thead className="bg-surface text-[10px] uppercase font-bold text-ink-400 tracking-widest">
                                    <tr>
                                        <th className="p-4 pl-6">Action Item Description</th>
                                        <th className="p-4">Owner</th>
                                        <th className="p-4">Due Date</th>
                                        <th className="p-4 pr-6 text-right">Status</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-surface-200/60 bg-surface-100/60 text-ink-900">
                                    {(meeting.actions || []).map((row, idx) => {
                                        const isOverdue = isOverdueDate(row.due, { closed: row.status === 'Closed' });
                                        return (
                                            <tr key={idx} className="hover:bg-surface-100 transition-colors">
                                                <td className="p-4 pl-6 font-medium whitespace-normal min-w-[250px]">{row.action}</td>
                                                <td className="p-4 font-bold text-blue-600">{actionOwnerDisplay(row)}</td>
                                                <td className="p-4 font-mono text-xs text-ink-600">
                                                    {row.due}
                                                    {isOverdue && <span className="ml-2 px-2 py-0.5 bg-red-100 text-red-600 border border-red-500/30 rounded font-bold uppercase text-[9px] animate-pulse">Overdue</span>}
                                                </td>
                                                <td className="p-4 pr-6 text-right">
                                                    <select
                                                        aria-label={`Status of action: ${row.action || `row ${idx + 1}`}`}
                                                        value={row.status || 'Open'}
                                                        onChange={e => onUpdateStatus(meeting.docKey, idx, e.target.value)}
                                                        disabled={!canEditStatus(row)}
                                                        className={`text-xs px-3 py-1.5 rounded-lg font-bold outline-hidden border ${canEditStatus(row) ? 'cursor-pointer' : 'cursor-not-allowed opacity-80'} ${row.status === 'Closed' ? 'bg-emerald-100 text-emerald-600 border-emerald-500/30' : row.status === 'In Progress' ? 'bg-yellow-100 text-yellow-600 border-yellow-500/30' : 'bg-red-100 text-red-600 border-red-500/30'}`}
                                                    >
                                                        <option value="Open">Open</option>
                                                        <option value="In Progress">In Progress</option>
                                                        <option value="Closed">Closed</option>
                                                    </select>
                                                </td>
                                            </tr>
                                        )
                                    })}
                                    {(!meeting.actions || meeting.actions.length === 0) && <tr><td colSpan="4" className="p-8 text-center text-ink-400 italic">No CAPA actions assigned.</td></tr>}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>

                <div className="p-6 border-t border-surface-200/70 flex justify-end gap-4 bg-surface flex-shrink-0">
                    <button onClick={() => onPrint(meeting)} className="bg-surface-100 hover:bg-surface-200 text-ink-900 px-6 py-2.5 rounded-xl font-bold text-sm transition-colors shadow-lg flex items-center gap-2"><Printer size={16} /> Print Minutes</button>
                    <button onClick={onClose} className="bg-green-600 hover:bg-green-500 text-white px-8 py-2.5 rounded-xl font-bold text-sm shadow-lg shadow-green-900/50 transition-transform active:scale-95">Close Window</button>
                </div>
            </div>
        </div>
    );
};

// ==========================================
// MAIN COMPONENT
// ==========================================
export default function Consultation() {
    const location = useLocation();
    const { profile, isAdmin, org } = useAuth();

    // Whether the HSE Committee scope config still includes a Site level. When an
    // admin removes Site from this module's granularity, meetings become org-level
    // and a specific site is no longer required.
    const scopeHasSite = useMemo(() => moduleLevelKeys(org, 'committee').includes(SITE_LEVEL_KEY), [org]);

    const [isLoading, setIsLoading] = useState(true);

    // Session-like object derived from the auth profile (keeps existing references working).
    const session = useMemo(() => (profile ? {
        name: profile.name, email: profile.email, role: profile.role, department: profile.department, dept: profile.dept,
    } : null), [profile]);

    // RBAC: every approved member can create/edit meetings (and CAPA actions);
    // deleting a whole meeting record stays admin-only.
    const permissions = useMemo(() => ({ viewOnly: false, canEditOwnedActions: true, canDelete: isAdmin, canEditCreate: true }), [isAdmin]);

    // Filter State
    const [filterSite, setFilterSite] = useState('All');
    const [filterCategory, setFilterCategory] = useState('All');

    // Calendar States
    const [calMonth, setCalMonth] = useState(new Date().getMonth());
    const [calYear, setCalYear] = useState(new Date().getFullYear());
    const [calSiteFilter, setCalSiteFilter] = useState('All');

    // Core Data
    const [sites, setSites] = useState([]);
    const [users, setUsers] = useState([]);
    const [meetings, setMeetings] = useState([]);

    // View States
    const [view, setView] = useState('list');
    const [printData, setPrintData] = useState(null);
    const [saving, setSaving] = useState(false);

    // Form Data State
    const [formData, setFormData] = useState({
        id: '', docKey: '', siteId: '', type: 'HSE Committee Meeting', subject: '',
        date: todayISO(), time: '', preRequisites: '', minutes: '',
        attendees: [], actions: []
    });

    const [selectedUserToAdd, setSelectedUserToAdd] = useState('');
    const [externalName, setExternalName] = useState('');
    const [newActionLine, setNewActionLine] = useState({ action: '', ownerKind: 'person', owner: '', department: '', due: '' });
    const departments = useMemo(() => orgDepartments(org), [org]);

    // Sync the active view from the ?view= query param so the sidebar's
    // Dashboard / Calendar / New Meeting links (and the in-page tabs) stay in sync.
    useEffect(() => {
        const params = new URLSearchParams(location.search);
        const pSite = params.get('site');
        if (pSite) { setFilterSite(pSite); setCalSiteFilter(pSite); }
        const v = params.get('view');
        if (v === 'calendar') {
            setView('calendar');
        } else if (v === 'new') {
            setFormData({
                id: '', docKey: '', siteId: filterSite !== 'All' ? filterSite : '',
                type: 'HSE Committee Meeting', subject: '',
                date: todayISO(), time: '', preRequisites: '', minutes: '',
                attendees: [], actions: []
            });
            setView('form');
        } else if (v === 'dashboard') {
            setView('list');
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [location.search]);

    // Live org data: sites, approved users and consultation records.
    useEffect(() => {
        const done = () => setIsLoading(false);
        // Never get stuck on the loader — always show the dashboard once auth is ready,
        // even if a listener is slow or a read is denied (it just renders empty then).
        const safety = setTimeout(done, 5000);
        const unsubSites = subscribeSites((list) => setSites(list), () => {});
        const unsubUsers = subscribeOrgUsers((list) => setUsers(list.filter(u => u.status === 'approved').map(u => ({ id: u.uid, ...u }))),
            () => {});
        const unsubMeetings = subscribeConsultations((list) => { setMeetings([...list].sort((a, b) => (toISODate(b.date) || '').localeCompare(toISODate(a.date) || ''))); done(); },
            () => done());
        return () => { clearTimeout(safety); unsubSites(); unsubUsers(); unsubMeetings(); };
    }, []);

    // ==========================================
    // 4. STRICT ROW-LEVEL SECURITY (RLS)
    // ==========================================
    // The site dropdowns offer every site; which meetings a person can read is
    // decided by the server's site rule (stack/policy.mjs siteBlocked).
    const isGlobalUser = true;
    const visibleSites = sites;

    const handleSiteFilterChange = (e) => setFilterSite(e.target.value);
    const handleCalSiteFilterChange = (e) => setCalSiteFilter(e.target.value);

    const canViewRecord = useCallback(() => true, []);

    // Records store the site id (site.code || site.id). Resolve it to the site's
    // display name for the UI; fall back to the stored value if not found.
    const siteName = useCallback((id) => {
        if (!id) return '—';
        const s = sites.find((x) => x.id === id || sameCentreId(x.code, id));
        return s?.name || id;
    }, [sites]);

    const canEditForm = useMemo(() => permissions.canEditCreate, [permissions.canEditCreate]);
    const canChangeActionStatus = (row) => canUpdateActionStatus(row, session, {
        elevated: session?.role === 'admin',
        canEditMeeting: canEditForm && actionOwnerKind(row) !== 'department',
    });

    // Open a blank New Meeting form (the old sidebar link that did this was removed
    // when the app moved to a hub layout, so the page needs its own buttons).
    const openNewMeeting = () => {
        setFormData({
            id: '', docKey: '', siteId: filterSite !== 'All' ? filterSite : '',
            type: 'HSE Committee Meeting', subject: '',
            date: todayISO(), time: '', preRequisites: '', minutes: '',
            attendees: [], actions: []
        });
        setView('form');
    };

    // --- Derived Filtering ---
    // All approved org members are selectable as attendees / action owners.
    const siteUsers = users;

    const filteredList = useMemo(() => {
        return meetings.filter(m => {
            if (!canViewRecord(m.siteId)) return false; // RLS Hard Block
            const matchSite = filterSite === 'All' || m.siteId === filterSite;
            const matchCat = filterCategory === 'All' || m.type === filterCategory;
            return matchSite && matchCat;
        });
    }, [meetings, filterSite, filterCategory, canViewRecord]);

    // Paging applies to the record cards only. The KPI tiles, every chart below
    // and the XLSX export all keep reading `filteredList`, so a page number never
    // truncates an export or skews the analytics.
    const { pageItems, page, setPage, pageCount, total, pageSize } = usePagination(filteredList);

    // ----- Dashboard analytics (respect the active site/category filters) -----
    const meetingsByType = useMemo(() => (
        MEETING_TYPES
            .map(t => ({ name: t, value: filteredList.filter(m => m.type === t).length }))
            .filter(d => d.value > 0)
    ), [filteredList]);

    const actionStatusData = useMemo(() => {
        const c = { 'Open': 0, 'In Progress': 0, 'Closed': 0 };
        filteredList.forEach(m => (m.actions || []).forEach(a => {
            const s = a.status || 'Open';
            c[s] = (c[s] || 0) + 1;
        }));
        return ['Open', 'In Progress', 'Closed'].map(s => ({ name: s, value: c[s] })).filter(d => d.value > 0);
    }, [filteredList]);

    const perMeetingActions = useMemo(() => (
        filteredList.slice(0, 12).map(m => {
            const acts = m.actions || [];
            const label = m.docId || m.subject || 'Meeting';
            return {
                name: label.length > 16 ? label.slice(0, 16) + '…' : label,
                Open: acts.filter(a => (a.status || 'Open') === 'Open').length,
                'In Progress': acts.filter(a => a.status === 'In Progress').length,
                Closed: acts.filter(a => a.status === 'Closed').length,
            };
        })
    ), [filteredList]);

    const meetingsBySite = useMemo(() => {
        const map = {};
        filteredList.forEach(m => { const k = siteName(m.siteId); map[k] = (map[k] || 0) + 1; });
        return Object.entries(map).map(([name, value]) => ({ name, value }));
    }, [filteredList, siteName]);

    // "Points in each meeting" = number of CAPA action items logged per meeting.
    const pointsPerMeeting = useMemo(() => (
        filteredList.slice(0, 12).map(m => {
            const label = m.docId || m.subject || 'Meeting';
            return {
                name: label.length > 16 ? label.slice(0, 16) + '…' : label,
                Points: (m.actions || []).length,
                Attendees: (m.attendees || []).length,
            };
        })
    ), [filteredList]);

    // Meetings logged per month (trend).
    const meetingsOverTime = useMemo(() => {
        const map = {};
        filteredList.forEach(m => { const ym = (m.date || '').slice(0, 7); if (ym) map[ym] = (map[ym] || 0) + 1; });
        return Object.keys(map).sort().map(ym => {
            const [y, mo] = ym.split('-');
            const label = new Date(Number(y), Number(mo) - 1, 1).toLocaleString('en', { month: 'short', year: '2-digit' });
            return { name: label, Meetings: map[ym] };
        });
    }, [filteredList]);

    const totalActions = useMemo(() => filteredList.reduce((a, m) => a + (m.actions ? m.actions.length : 0), 0), [filteredList]);


    // --- Handlers ---
    const handleAddAttendee = (type) => {
        if (!canEditForm) return;
        if (type === 'external') {
            if (!externalName.trim()) return toast.error("Enter external attendee name.");
            if ((formData.attendees || []).some(a => a.name.toLowerCase() === externalName.trim().toLowerCase())) return toast.error("Attendee is already in the list.");
            const newAttendee = { userId: 'External', name: externalName.trim(), role: 'External / Contractor', dept: 'N/A' };
            setFormData(prev => ({ ...prev, attendees: [...(prev.attendees || []), newAttendee] }));
            setExternalName('');
        } else {
            if (!selectedUserToAdd) return;
            const userObj = users.find(u => u.name === selectedUserToAdd || u.email === selectedUserToAdd);
            if ((formData.attendees || []).some(a => a.name === selectedUserToAdd)) return toast.error("Employee is already in the list.");
            const newAttendee = { userId: userObj ? userObj.id : 'Internal', name: userObj ? (userObj.name || userObj.email) : selectedUserToAdd, role: userObj ? (userObj.designation || userObj.role) : 'Employee', dept: userObj ? userObj.department : 'N/A' };
            setFormData(prev => ({ ...prev, attendees: [...(prev.attendees || []), newAttendee] }));
            setSelectedUserToAdd('');
        }
    };

    const removeAttendee = (i) => {
        if (!canEditForm) return;
        setFormData({ ...formData, attendees: formData.attendees.filter((_, x) => x !== i) });
    }

    const addAction = () => {
        if (!canEditForm) return;
        const owner = actionOwnerRecord(newActionLine);
        if (newActionLine.action && actionOwnerText(owner)) {
            setFormData({ ...formData, actions: [...(formData.actions || []), { ...newActionLine, ...owner, status: 'Open' }] });
            setNewActionLine({ action: '', ownerKind: 'person', owner: '', department: '', due: '' });
        } else {
            toast.error("Each action needs a description and either a department or a person.");
        }
    };

    const updateAction = (i, field, val) => {
        if (!canEditForm) return;
        const na = [...formData.actions]; na[i][field] = val; setFormData({ ...formData, actions: na });
    };
    const removeAction = (i) => {
        if (!canEditForm) return;
        setFormData({ ...formData, actions: formData.actions.filter((_, x) => x !== i) });
    }

    const saveRecord = async () => {
        if (!canEditForm) return;
        if (!formData.subject) return toast.error("Subject is required.");
        // Minutes record a meeting that HAS taken place. A future date files
        // an unheld meeting as held, with its attendees and its actions.
        if (isFutureDate(formData.date)) return toast.error("The meeting date cannot be in the future.");
        if (scopeHasSite && !formData.siteId) return toast.error("Site is required.");
        if ((formData.actions || []).some((a) => !actionOwnerText(a))) {
            return toast.error("Each action needs either a department or a person.");
        }

        setSaving(true);
        // docKey is the record id (a local handle), not a stored field.
        const { docKey, ...rest } = formData;
        const payload = {
            ...rest,
            actions: (rest.actions || []).map((a) => ({ ...a, ...actionOwnerRecord(a) })),
            timestamp: new Date().toISOString(),
            createdBy: session.name || session.email,
        };

        try {
            if (docKey) {
                // A meeting saved before references existed has none. It used to
                // be given `MOM-<site>-<last 4 digits of the clock>` — a ten
                // SECOND cycle, so two meetings for one site minuted in the same
                // window took the same reference, and that value is what the
                // minutes, the export and the Action Tracker all quote.
                //
                // Reserve a real one instead. Only on the update path:
                // addConsultation reserves its own after spreading the payload,
                // so anything sent on a create was discarded anyway.
                payload.docId = formData.docId || await reserveDocId('committee');
                await updateConsultation(docKey, payload);
            } else {
                delete payload.docId;
                // The creator's uid, set once: stack/policy.mjs lets an employee
                // edit a meeting they recorded, and `createdBy` holds a name.
                await addConsultation({ ...payload, createdByUid: profile?.uid || null });
            }
            toast.success("Record saved successfully!");
            // The onSnapshot subscription refreshes the list automatically.
            setView('list');
        } catch (e) { toastCaught(e, 'Save failed') }
        finally { setSaving(false); }
    };

    const deleteRecord = (key) => {
        if (!permissions.canDelete) return;
        toast((t) => (
            <div className="flex flex-col gap-2.5">
                <span className="text-sm font-semibold text-white">Delete this meeting record permanently?</span>
                <div className="flex justify-end gap-2">
                    <button onClick={() => toast.dismiss(t.id)} className="px-3 py-1.5 rounded-lg text-xs font-bold bg-white/10 text-white hover:bg-white/20 transition-colors">Cancel</button>
                    <button
                        onClick={async () => {
                            toast.dismiss(t.id);
                            try { await deleteConsultation(key); toast.success("Record deleted"); }
                            catch (e) { toastCaught(e, 'Delete failed') }
                        }}
                        className="px-3 py-1.5 rounded-lg text-xs font-bold bg-red-600 text-white hover:bg-red-500 transition-colors"
                    >Delete</button>
                </div>
            </div>
        ), { duration: 8000 });
    };

    const quickStatusUpdate = async (key, idx, newStatus) => {
        const meeting = meetings.find(m => m.docKey === key);
        const actionRow = meeting.actions[idx];

        if (!canUpdateActionStatus(actionRow, session, {
            elevated: session?.role === 'admin',
            canEditMeeting: permissions.canEditCreate && actionOwnerKind(actionRow) !== 'department',
        })) {
            return toast.error(actionOwnerKind(actionRow) === 'department'
                ? "Only someone in that department, or an admin, can close this action."
                : "You can only update actions assigned to you.");
        }

        // The ACTION is replaced, not written into. [...meeting.actions] is a
        // shallow copy, so updatedActions[idx] was still the object the live
        // meetings list holds — every other view of that meeting saw the new
        // status before the write had been accepted, and would have kept it if
        // the write failed.
        const updatedActions = meeting.actions.map((a, x) =>
            (x === idx ? { ...a, status: newStatus } : a));
        await updateConsultation(key, { actions: updatedActions });
        setMeetings(meetings.map(m => m.docKey === key ? { ...m, actions: updatedActions } : m));

        if (formData && formData.docKey === key) {
            setFormData(prev => ({ ...prev, actions: updatedActions }));
        }
    };

    const triggerPrint = (dataObj) => { setPrintData(dataObj); setTimeout(() => window.print(), 800); };

    // --- Compliance Logic ---
    const pendingMeetings = useMemo(() => {
        if (!calSiteFilter || calSiteFilter === 'All') return [];
        const pending = [];
        const currentM = calMonth;
        const currentY = calYear;

        const siteConsultations = meetings.filter(c => c.siteId === calSiteFilter);

        const hasMeetingThisMonth = (type) => siteConsultations.some(c => {
            if (!c.date) return false;
            const parts = c.date.split('-');
            if (parts.length < 3) return false;
            return c.type === type && parseInt(parts[1], 10) - 1 === currentM && parseInt(parts[0], 10) === currentY;
        });

        const hasMeetingThisYear = (type) => siteConsultations.some(c => {
            if (!c.date) return false;
            const parts = c.date.split('-');
            if (parts.length < 1) return false;
            return c.type === type && parseInt(parts[0], 10) === currentY;
        });

        if (!hasMeetingThisMonth('HSE Committee Meeting')) pending.push('HSE Committee Meeting');
        if (!hasMeetingThisYear('Management Review')) pending.push('Management Review');
        if (!hasMeetingThisYear('Policy Review')) pending.push('Policy Review');
        if (!hasMeetingThisYear('Risk Assessment Review')) pending.push('Risk Assessment Review');
        if (!hasMeetingThisYear('Emergency Planning')) pending.push('Emergency Planning');

        return pending;
    }, [meetings, calSiteFilter, calMonth, calYear]);

    const getFreqLabel = (type) => {
        if (type === 'HSE Committee Meeting') return 'Monthly Requirement';
        if (type === 'Risk Assessment Review') return 'Annual Requirement';
        return 'Yearly Requirement';
    };

    const handleLogPending = (type) => {
        if (!permissions.canEditCreate) return;
        const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
        const today = new Date();
        setFormData({
            id: '', docKey: '', siteId: calSiteFilter, type: type,
            subject: `${type} _ ${monthNames[calMonth]} _ ${calYear}`,
            date: todayISO(today), time: '', preRequisites: '', minutes: '',
            attendees: [], actions: []
        });
        setView('form');
    };

    if (isLoading || !session) return (
        <div className="flex items-center justify-center py-24">
            <LogoLoader size={104} label="Loading meeting registry…" />
        </div>
    );

    return (
        <div>
            {/* PAGE HEADER */}
            <div className="mb-6 flex items-center gap-3 print:hidden">
                <ModuleMark tone="brand" size="md"><Logo size={24} /></ModuleMark>
                <div>
                    <h1 className="text-2xl font-extrabold tracking-tight text-ink-900">
                        {view === 'calendar' ? 'Compliance Calendar' : view === 'form' ? (formData.docKey ? (canEditForm ? 'Edit Meeting' : 'Meeting Record') : 'New Meeting') : 'Consultation & Meetings'}
                    </h1>
                    <p className="text-sm text-ink-500">HSE committees, management reviews and consultations.</p>
                </div>
                {permissions.viewOnly && <span className="chip bg-yellow-100 text-yellow-700 ml-1"><Eye size={16} className="inline mr-1" /> Read Only</span>}
                {view !== 'list' && (
                    <button type="button" onClick={() => setView('list')} className="ml-auto bg-surface-100 hover:bg-surface-200 text-ink-900 px-4 py-2.5 rounded-xl font-bold text-xs shadow flex items-center gap-2 transition-colors border border-surface-300"><ArrowLeft size={14} /> Dashboard</button>
                )}
            </div>

            {/* MAIN CONTENT - Hidden on Print */}
            <div className="print:hidden">

                {/* -------------------- VIEW: LIST / REPOSITORY -------------------- */}
                {view === 'list' && (
                    <div className="max-w-7xl mx-auto space-y-8 animate-in fade-in duration-500 pb-20">
                        <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-4 mb-4">
                            <p className="text-sm text-ink-500">Live overview of meetings, types, CAPA action status and per-site compliance.</p>
                            <div className="flex items-center gap-3">
                                <div className="bg-surface border border-surface-200 p-1.5 rounded-xl flex gap-2">
                                    <select className="bg-surface text-ink-900 text-xs font-bold px-3 py-2 rounded-lg outline-hidden border border-surface-200/70 focus:border-green-500" value={filterSite} onChange={handleSiteFilterChange}>
                                        {(isGlobalUser || visibleSites.length > 1) && <option value="All">All Authorized Sites</option>}
                                        {visibleSites.map((s, idx) => <option key={s.id || idx} value={s.code || s.id}>{s.name}</option>)}
                                    </select>
                                    <select className="bg-surface text-ink-900 text-xs font-bold px-3 py-2 rounded-lg outline-hidden border border-surface-200/70 focus:border-green-500" value={filterCategory} onChange={e => setFilterCategory(e.target.value)}>
                                        <option value="All">All Categories</option>
                                        {MEETING_TYPES.map(t => <option key={t}>{t}</option>)}
                                    </select>
                                </div>
                                <button type="button" onClick={() => {
                                    const sheets = meetingExportSheets(filteredList, siteName);
                                    const wb = XLSX.utils.book_new();
                                    XLSX.utils.book_append_sheet(wb, jsonToSheet(sheets.meetings), "Meetings");
                                    XLSX.utils.book_append_sheet(wb, jsonToSheet(sheets.actions), "Actions");
                                    XLSX.writeFile(wb, "Meetings_Export.xlsx");
                                }} className="bg-surface-100 hover:bg-surface-200 text-ink-900 px-4 py-2.5 rounded-xl font-bold text-xs shadow flex items-center gap-2 transition-colors border border-surface-300"><FileSpreadsheet size={14} className="text-emerald-600" /> Export</button>
                                <button type="button" onClick={() => setView('calendar')} className="bg-surface-100 hover:bg-surface-200 text-ink-900 px-4 py-2.5 rounded-xl font-bold text-xs shadow flex items-center gap-2 transition-colors border border-surface-300"><Calendar size={14} className="text-brand-600" /> Calendar</button>
                                {canEditForm && (
                                    <button data-write type="button" onClick={openNewMeeting} className="btn-primary whitespace-nowrap"><Plus size={14} /> New Meeting</button>
                                )}
                            </div>
                        </div>

                        <div className="grid grid-cols-2 lg:grid-cols-4 gap-6">
                            <div className="glass-panel p-6 rounded-3xl border-l-4 border-green-500 shadow-xl flex justify-between items-center group hover:border-green-400 transition-colors">
                                <div><p className="text-xs text-ink-500 uppercase font-bold tracking-widest mb-1">Meetings Held</p><h3 className="text-4xl font-black text-ink-900">{filteredList.length}</h3></div>
                                <div className="w-12 h-12 rounded-full bg-green-100 flex items-center justify-center text-green-600/50 group-hover:text-green-700 transition-colors"><Handshake size={24} /></div>
                            </div>
                            <div className="glass-panel p-6 rounded-3xl border-l-4 border-sky-500 shadow-xl flex justify-between items-center group hover:border-sky-400 transition-colors">
                                <div><p className="text-xs text-ink-500 uppercase font-bold tracking-widest mb-1">Action Points</p><h3 className="text-4xl font-black text-sky-600">{totalActions}</h3></div>
                                <div className="w-12 h-12 rounded-full bg-sky-100 flex items-center justify-center text-sky-600/50 group-hover:text-sky-600 transition-colors"><ListOrdered size={24} /></div>
                            </div>
                            <div className="glass-panel p-6 rounded-3xl border-l-4 border-emerald-500 shadow-xl flex justify-between items-center group hover:border-emerald-400 transition-colors">
                                <div><p className="text-xs text-ink-500 uppercase font-bold tracking-widest mb-1">Actions Closed</p><h3 className="text-4xl font-black text-emerald-600">{filteredList.reduce((acc, curr) => acc + (curr.actions ? curr.actions.filter(a => a.status === 'Closed').length : 0), 0)}</h3></div>
                                <div className="w-12 h-12 rounded-full bg-emerald-100 flex items-center justify-center text-emerald-600/50 group-hover:text-emerald-600 transition-colors"><CheckCircle2 size={24} /></div>
                            </div>
                            <div className="glass-panel p-6 rounded-3xl border-l-4 border-yellow-500 shadow-xl flex justify-between items-center group hover:border-yellow-400 transition-colors">
                                <div><p className="text-xs text-ink-500 uppercase font-bold tracking-widest mb-1">Pending Actions</p><h3 className="text-4xl font-black text-yellow-600">{filteredList.reduce((acc, curr) => acc + (curr.actions ? curr.actions.filter(a => a.status !== 'Closed').length : 0), 0)}</h3></div>
                                <div className="w-12 h-12 rounded-full bg-yellow-100 flex items-center justify-center text-yellow-600/50 group-hover:text-yellow-600 transition-colors"><Clock size={24} /></div>
                            </div>
                        </div>

                        {/* -------------------- ANALYTICS / CHARTS -------------------- */}
                        <div className="space-y-6">
                            <h3 className="text-xs uppercase text-ink-500 font-bold tracking-widest flex items-center gap-2"><ChartColumn size={14} className="text-green-600" /> Analytics Overview</h3>

                            {filteredList.length === 0 && (
                                <div className="glass-panel p-10 rounded-3xl shadow-xl text-center text-ink-400">
                                    <ChartPie size={28} className="mx-auto mb-3 text-surface-300" />
                                    <p className="text-sm font-medium">No data to chart yet. Charts populate automatically as you log meetings.</p>
                                </div>
                            )}

                            {filteredList.length > 0 && (
                                <>
                                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                                        {/* Donut — meetings by type */}
                                        <div className="glass-panel p-6 rounded-3xl shadow-xl">
                                            <h4 className="text-xs uppercase text-ink-500 font-bold mb-4 tracking-widest"><ChartPie size={14} className="inline mr-2 text-green-600" />Meetings by Type</h4>
                                            <ChartFrame label="Meetings by type" width="100%" height={260}>
                                                <PieChart>
                                                    <Pie data={meetingsByType} dataKey="value" nameKey="name" innerRadius={55} outerRadius={95} paddingAngle={2}>
                                                        {meetingsByType.map((e, i) => <Cell key={i} fill={TYPE_COLORS[i % TYPE_COLORS.length]} />)}
                                                    </Pie>
                                                    <Tooltip />
                                                    <Legend wrapperStyle={{ fontSize: 11 }} />
                                                </PieChart>
                                            </ChartFrame>
                                        </div>

                                        {/* Donut — action status */}
                                        <div className="glass-panel p-6 rounded-3xl shadow-xl">
                                            <h4 className="text-xs uppercase text-ink-500 font-bold mb-4 tracking-widest"><ListChecks size={14} className="inline mr-2 text-green-600" />Overall Action Status</h4>
                                            {actionStatusData.length > 0 ? (
                                                <ChartFrame label="Overall action status" width="100%" height={260}>
                                                    <PieChart>
                                                        <Pie data={actionStatusData} dataKey="value" nameKey="name" innerRadius={55} outerRadius={95} paddingAngle={2}>
                                                            {actionStatusData.map((e, i) => <Cell key={i} fill={STATUS_COLORS[e.name]} />)}
                                                        </Pie>
                                                        <Tooltip />
                                                        <Legend wrapperStyle={{ fontSize: 11 }} />
                                                    </PieChart>
                                                </ChartFrame>
                                            ) : (
                                                <div className="flex items-center justify-center h-[260px] text-ink-400 italic text-sm">No CAPA actions recorded yet.</div>
                                            )}
                                        </div>
                                    </div>

                                    {/* Stacked bar — action status per meeting */}
                                    <div className="glass-panel p-6 rounded-3xl shadow-xl">
                                        <h4 className="text-xs uppercase text-ink-500 font-bold mb-4 tracking-widest"><ChartColumn size={14} className="inline mr-2 text-green-600" />Action Status per Meeting <span className="text-ink-400 normal-case font-medium tracking-normal">(latest {perMeetingActions.length})</span></h4>
                                        <ChartFrame label="Action status per meeting" width="100%" height={320}>
                                            <BarChart data={perMeetingActions} margin={{ top: 8, right: 12, left: -10, bottom: 8 }}>
                                                <CartesianGrid strokeDasharray="3 3" stroke="#e3ccbf" vertical={false} />
                                                <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#62718c' }} angle={-25} textAnchor="end" height={72} interval={0} />
                                                <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#62718c' }} />
                                                <Tooltip />
                                                <Legend wrapperStyle={{ fontSize: 11 }} />
                                                <Bar dataKey="Open" stackId="a" fill="#ef4444" />
                                                <Bar dataKey="In Progress" stackId="a" fill="#facc15" />
                                                <Bar dataKey="Closed" stackId="a" fill="#22c55e" radius={[4, 4, 0, 0]} />
                                            </BarChart>
                                        </ChartFrame>
                                    </div>

                                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                                        {/* Bar — points (action items) per meeting */}
                                        <div className="glass-panel p-6 rounded-3xl shadow-xl">
                                            <h4 className="text-xs uppercase text-ink-500 font-bold mb-4 tracking-widest"><ListOrdered size={14} className="inline mr-2 text-green-600" />Points per Meeting</h4>
                                            <ChartFrame label="Points per meeting" width="100%" height={280}>
                                                <BarChart data={pointsPerMeeting} margin={{ top: 8, right: 12, left: -10, bottom: 8 }}>
                                                    <CartesianGrid strokeDasharray="3 3" stroke="#e3ccbf" vertical={false} />
                                                    <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#62718c' }} angle={-25} textAnchor="end" height={70} interval={0} />
                                                    <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#62718c' }} />
                                                    <Tooltip />
                                                    <Legend wrapperStyle={{ fontSize: 11 }} />
                                                    <Bar dataKey="Points" fill="#0ea5e9" radius={[5, 5, 0, 0]} />
                                                    <Bar dataKey="Attendees" fill="#8b5cf6" radius={[5, 5, 0, 0]} />
                                                </BarChart>
                                            </ChartFrame>
                                        </div>

                                        {/* Bar — meetings by site */}
                                        <div className="glass-panel p-6 rounded-3xl shadow-xl">
                                            <h4 className="text-xs uppercase text-ink-500 font-bold mb-4 tracking-widest"><MapPin size={14} className="inline mr-2 text-green-600" />Meetings by Site</h4>
                                            <ChartFrame label="Meetings by site" width="100%" height={280}>
                                                <BarChart data={meetingsBySite} margin={{ top: 8, right: 12, left: -10, bottom: 8 }}>
                                                    <CartesianGrid strokeDasharray="3 3" stroke="#e3ccbf" vertical={false} />
                                                    <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#62718c' }} />
                                                    <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#62718c' }} />
                                                    <Tooltip />
                                                    <Bar dataKey="value" name="Meetings" fill="#16a34a" radius={[6, 6, 0, 0]} />
                                                </BarChart>
                                            </ChartFrame>
                                        </div>
                                    </div>

                                    {/* Area — meetings logged over time */}
                                    <div className="glass-panel p-6 rounded-3xl shadow-xl">
                                        <h4 className="text-xs uppercase text-ink-500 font-bold mb-4 tracking-widest"><ChartArea size={14} className="inline mr-2 text-green-600" />Meetings Over Time</h4>
                                        <ChartFrame label="Meetings over time" width="100%" height={240}>
                                            <AreaChart data={meetingsOverTime} margin={{ top: 8, right: 12, left: -10, bottom: 8 }}>
                                                <defs>
                                                    <linearGradient id="mtg" x1="0" y1="0" x2="0" y2="1">
                                                        <stop offset="0%" stopColor="#22c55e" stopOpacity={0.5} />
                                                        <stop offset="100%" stopColor="#22c55e" stopOpacity={0.05} />
                                                    </linearGradient>
                                                </defs>
                                                <CartesianGrid strokeDasharray="3 3" stroke="#e3ccbf" vertical={false} />
                                                <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#62718c' }} />
                                                <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#62718c' }} />
                                                <Tooltip />
                                                <Area type="monotone" dataKey="Meetings" stroke="#16a34a" strokeWidth={2} fill="url(#mtg)" />
                                            </AreaChart>
                                        </ChartFrame>
                                    </div>
                                </>
                            )}
                        </div>

                        <h3 className="text-xs uppercase text-ink-500 font-bold tracking-widest flex items-center gap-2 pt-2"><FolderOpen size={14} className="text-green-600" /> Meeting Records</h3>
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                            {pageItems.map(m => {
                                const totalAct = m.actions ? m.actions.length : 0;
                                const closedAct = m.actions ? m.actions.filter(a => a.status === 'Closed').length : 0;
                                return (
                                    <button type="button" key={m.docKey} className="glass-panel p-6 rounded-3xl border-t-4 border-green-500 flex flex-col w-full text-left shadow-xl hover:shadow-2xl hover:-translate-y-1 transition-all cursor-pointer group" onClick={() => { setFormData(m); setView('detail'); }}>
                                        <div className="flex justify-between items-start mb-4">
                                            <span className="font-mono text-[10px] font-bold text-green-700 bg-green-100 px-2 py-1 rounded-lg border border-green-500/30">{m.docId}</span>
                                            <span className="text-[10px] bg-surface text-ink-600 px-2 py-1 rounded-lg border border-surface-200 font-bold"><Calendar size={12} className="inline mr-1" /> {m.date}</span>
                                        </div>
                                        <h3 className="font-bold text-ink-900 text-lg mb-2 line-clamp-2 leading-tight group-hover:text-green-700 transition-colors">{m.subject}</h3>
                                        <p className="text-[10px] text-ink-500 mb-6 uppercase tracking-widest font-bold">{siteName(m.siteId)} • {m.type}</p>
                                        <div className="mt-auto flex justify-between items-center border-t border-surface-200/70 pt-4">
                                            <div className="flex items-center gap-2">
                                                <span className="text-[10px] font-bold text-ink-500 bg-surface px-2.5 py-1 rounded-lg border border-surface-200/70"><Users size={12} className="inline text-purple-700 mr-1.5" /> {(m.attendees || []).length}</span>
                                                <span className={`text-[10px] font-bold px-2.5 py-1 rounded-lg border ${totalAct > 0 && closedAct === totalAct ? 'bg-emerald-100 text-emerald-600 border-emerald-500/30' : 'bg-surface text-ink-500 border-surface-200/70'}`}>
                                                    <ListTodo size={12} className="inline text-blue-600 mr-1.5" /> CAPA: {closedAct}/{totalAct}
                                                </span>
                                            </div>
                                            <div className="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                                {permissions.canEditCreate ? (
                                                    <button type="button" onClick={e => { e.stopPropagation(); setFormData(m); setView('form'); }} className="text-blue-600 hover:text-white bg-surface-100 hover:bg-blue-600 w-8 h-8 rounded-lg flex items-center justify-center transition-colors shadow-lg"><Pencil size={16} /></button>
                                                ) : (
                                                    <button type="button" onClick={e => { e.stopPropagation(); setFormData(m); setView('form'); }} className="text-ink-500 hover:text-ink-900 bg-surface-100 hover:bg-surface-200 w-8 h-8 rounded-lg flex items-center justify-center transition-colors shadow-lg"><Eye size={16} /></button>
                                                )}

                                                {permissions.canDelete && <button type="button" onClick={e => { e.stopPropagation(); deleteRecord(m.docKey); }} className="text-red-600 hover:text-white bg-surface-100 hover:bg-red-600 w-8 h-8 rounded-lg flex items-center justify-center transition-colors shadow-lg"><Trash2 size={16} /></button>}
                                            </div>
                                        </div>
                                    </button>
                                );
                            })}
                            {filteredList.length === 0 && <div className="col-span-full text-center p-16 text-ink-400 italic text-lg border-2 border-dashed border-surface-200/70 rounded-3xl bg-surface-100/60">No meeting records found matching your filters.</div>}
                        </div>
                        <Pager
                            className="border-t border-surface-200/70 px-1 pt-4"
                            page={page} pageCount={pageCount} onPage={setPage} total={total} pageSize={pageSize}
                        />
                    </div>
                )}

                {/* -------------------- VIEW: CALENDAR -------------------- */}
                {view === 'calendar' && (
                    <div className="max-w-7xl mx-auto space-y-6 animate-in fade-in duration-500 pb-20">
                        <div className="flex justify-between items-center bg-surface p-6 rounded-3xl border border-surface-200 shadow-xl">
                            <div className="flex items-center gap-4">
                                <label htmlFor="consult-compliance-site" className="text-xs uppercase font-bold text-ink-500 tracking-widest">Compliance Site</label>
                                <select id="consult-compliance-site" className="bg-surface p-3 rounded-xl w-64 border border-surface-200/70 text-sm font-bold text-green-700 outline-hidden focus:border-green-500 transition-colors" value={calSiteFilter} onChange={handleCalSiteFilterChange}>
                                    {(isGlobalUser || visibleSites.length > 1) && <option value="All">All Authorized Sites</option>}
                                    {visibleSites.map((s, idx) => <option key={s.id || idx} value={s.code || s.id}>{s.name}</option>)}
                                </select>
                            </div>
                            <div className="flex items-center gap-2 bg-surface rounded-xl p-1.5 border border-surface-200/70">
                                <button type="button" onClick={() => { if (calMonth === 0) { setCalMonth(11); setCalYear(y => y - 1) } else { setCalMonth(m => m - 1) } }} className="px-4 py-2 hover:bg-surface-100 rounded-lg text-ink-600 transition-colors"><ChevronLeft size={16} className="inline" /></button>
                                <span className="font-bold w-40 text-center text-ink-900 text-sm tracking-wide">{["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][calMonth]} {calYear}</span>
                                <button type="button" onClick={() => { if (calMonth === 11) { setCalMonth(0); setCalYear(y => y + 1) } else { setCalMonth(m => m + 1) } }} className="px-4 py-2 hover:bg-surface-100 rounded-lg text-ink-600 transition-colors"><ChevronRight size={16} className="inline" /></button>
                            </div>
                        </div>

                        {calSiteFilter && calSiteFilter !== 'All' ? (
                            <div className="mb-8">
                                <h3 className="text-lg font-bold text-orange-600 mb-4 flex items-center gap-2"><AlertCircle size={18} /> Mandatory Compliance Tracking</h3>
                                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                                    {pendingMeetings.map((p, idx) => (
                                        <div key={idx} className="bg-surface border border-orange-500/30 p-5 rounded-2xl flex flex-col justify-between shadow-xl relative overflow-hidden group hover:border-orange-500 transition-colors">
                                            <div className="absolute left-0 top-0 bottom-0 w-1.5 bg-gradient-to-b from-orange-400 to-red-500"></div>
                                            <div className="pl-3 mb-4">
                                                <div className="font-bold text-ink-900 text-base leading-tight mb-2 group-hover:text-orange-600 transition-colors">{p}</div>
                                                <div className="text-[10px] text-ink-500 bg-surface font-bold uppercase tracking-widest inline-block px-2.5 py-1 rounded-lg border border-surface-200/70">
                                                    {getFreqLabel(p)} Due
                                                </div>
                                            </div>
                                            {permissions.canEditCreate && <button type="button" onClick={() => handleLogPending(p)} className="w-full bg-orange-100 hover:bg-orange-600 text-orange-600 hover:text-white border border-orange-500/20 px-4 py-3 rounded-xl text-xs font-bold uppercase tracking-widest transition-colors shadow-sm">Log Meeting Now</button>}
                                        </div>
                                    ))}
                                    {pendingMeetings.length === 0 && <div className="text-emerald-600 font-bold p-6 bg-emerald-50 rounded-2xl border border-emerald-500/20 w-full col-span-full flex items-center gap-3"><CheckCircle2 size={28} /> All mandated statutory meetings for this period are completely up to date!</div>}
                                </div>
                            </div>
                        ) : (
                            <div className="text-yellow-600 italic text-sm p-6 bg-yellow-50 rounded-2xl border border-yellow-500/20 w-full mb-8 font-bold text-center">Please select a specific facility site from the dropdown to view compliance status.</div>
                        )}

                        <div className="glass-panel p-8 rounded-3xl shadow-2xl border border-surface-200">
                            <div className="grid grid-cols-7 border-t border-l border-surface-200/70 rounded-2xl overflow-hidden bg-surface shadow-2xl">
                                {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(day => (
                                    <div key={day} className="p-4 text-center text-xs font-bold text-ink-400 uppercase tracking-widest border-r border-b border-surface-200/70 bg-surface">{day}</div>
                                ))}
                                {(() => {
                                    const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
                                    const firstDayIndex = new Date(calYear, calMonth, 1).getDay();
                                    const boxes = [];
                                    for (let i = 0; i < firstDayIndex; i++) boxes.push(<div key={`empty-${i}`} className="p-2 border-r border-b border-surface-200/70 bg-surface-100/50 min-h-[140px]"></div>);
                                    for (let d = 1; d <= daysInMonth; d++) {
                                        const dateStr = `${calYear}-${String(calMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

                                        const dayMeetings = meetings.filter(c => {
                                            if (!canViewRecord(c.siteId)) return false;
                                            return c.date === dateStr && (calSiteFilter === 'All' || c.siteId === calSiteFilter);
                                        });

                                        boxes.push(
                                            <div key={d} className="p-3 border-r border-b border-surface-200/70 bg-surface hover:bg-surface-100 transition-colors min-h-[140px] flex flex-col group">
                                                <span className="font-bold text-ink-400 block text-right mb-2 text-sm group-hover:text-ink-600 transition-colors">{d}</span>
                                                <div className="flex-1 space-y-2 overflow-y-auto custom-scroll pr-1">
                                                    {dayMeetings.map((m, i) => (
                                                        <button type="button" key={i} onClick={() => { setFormData(m); setView('detail'); }} className="text-[10px] font-bold bg-green-100 text-green-700 p-2 rounded-lg leading-tight border border-green-500/30 cursor-pointer shadow-sm hover:bg-green-600 hover:text-white transition-colors truncate uppercase tracking-wider w-full text-left" title={m.subject}>
                                                            {m.type}
                                                        </button>
                                                    ))}
                                                </div>
                                            </div>
                                        );
                                    }
                                    return boxes;
                                })()}
                            </div>
                        </div>
                    </div>
                )}

                {/* -------------------- VIEW: FORM -------------------- */}
                {view === 'form' && (
                    <div className="max-w-6xl mx-auto space-y-8 animate-in slide-in-from-bottom-8 duration-500 pb-20">
                        <div className="glass-panel p-8 md:p-10 rounded-3xl border border-surface-200 shadow-2xl">
                            <div className="flex justify-between items-center mb-10 border-b border-surface-200 pb-6">
                                <div>
                                    <h2 className="text-3xl font-bold text-green-700 flex items-center gap-4"><Pencil size={24} /> {formData.docKey ? (canEditForm ? 'Edit Consultation Record' : 'View Consultation Record') : 'Log New Meeting'}</h2>
                                    <p className="text-sm text-ink-500 font-mono mt-2 ml-10">Ref: {formData.docId || 'DRAFT'}</p>
                                </div>
                                <div className="flex gap-3">
                                    <button type="button" onClick={() => setView('list')} className="text-ink-500 hover:text-ink-900 px-5 py-2.5 rounded-xl font-bold text-sm transition-colors">Cancel</button>
                                    {formData.docKey && <button type="button" onClick={() => triggerPrint(formData)} className="bg-surface-100 hover:bg-surface-200 text-ink-900 px-6 py-2.5 rounded-xl font-bold text-sm shadow-lg transition-colors flex items-center gap-2"><Printer size={16} /> Print</button>}
                                    {canEditForm && (
                                        <button type="button" onClick={saveRecord} disabled={saving} className="bg-gradient-to-r from-green-600 to-emerald-600 hover:from-green-500 hover:to-emerald-500 text-white font-bold px-6 py-2.5 rounded-xl text-sm shadow-lg shadow-green-900/30 transition-transform active:scale-95 flex items-center gap-2 disabled:opacity-50">{saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save</button>
                                    )}
                                </div>
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-3 gap-8 mb-10 bg-surface p-8 rounded-2xl border border-surface-200/70">
                                <div className="md:col-span-3">
                                    <span className="text-[10px] uppercase font-bold text-ink-400 block mb-2 tracking-widest ml-1">Facility / Site Scope</span>
                                    <SiteScopePicker
                                        module="committee"
                                        sites={visibleSites}
                                        value={formData}
                                        disabled={!canEditForm || (formData.docKey && !isGlobalUser)}
                                        onChange={(v) => setFormData((f) => ({ ...f, ...v, ...(v.siteId !== f.siteId ? { attendees: [], actions: [] } : {}) }))}
                                    />
                                </div>
                                <div>
                                    <label htmlFor="consult-category" className="text-[10px] uppercase font-bold text-ink-400 block mb-2 tracking-widest ml-1">Meeting Category</label>
                                    <select id="consult-category" className="w-full bg-surface border border-surface-200 p-3.5 rounded-xl text-sm font-bold text-green-700 focus:border-green-500 outline-hidden transition-colors" value={formData.type} onChange={e => setFormData({ ...formData, type: e.target.value })} disabled={!canEditForm}>
                                        {MEETING_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                                    </select>
                                </div>
                                <div className="grid grid-cols-2 gap-4">
                                    <div>
                                        <label htmlFor="consult-date" className="text-[10px] uppercase font-bold text-ink-400 block mb-2 tracking-widest ml-1">Date</label>
                                        <input id="consult-date" type="date" max={todayISO()} value={formData.date} onChange={e => setFormData({ ...formData, date: e.target.value })} disabled={!canEditForm} className="w-full bg-surface border border-surface-200 p-3.5 rounded-xl text-sm text-ink-900 outline-hidden font-mono transition-colors focus:border-green-500" />
                                    </div>
                                    <div>
                                        <label htmlFor="consult-time" className="text-[10px] uppercase font-bold text-ink-400 block mb-2 tracking-widest ml-1">Time</label>
                                        <input id="consult-time" type="time" value={formData.time} onChange={e => setFormData({ ...formData, time: e.target.value })} disabled={!canEditForm} className="w-full bg-surface border border-surface-200 p-3.5 rounded-xl text-sm text-ink-900 outline-hidden font-mono transition-colors focus:border-green-500" />
                                    </div>
                                </div>
                                <div className="md:col-span-3">
                                    <label htmlFor="consult-subject" className="text-[10px] uppercase font-bold text-ink-400 block mb-2 tracking-widest ml-1">Subject / Primary Agenda</label>
                                    <input id="consult-subject" value={formData.subject} onChange={e => setFormData({ ...formData, subject: e.target.value })} placeholder="Main topic of discussion..." disabled={!canEditForm} maxLength={200} className="w-full bg-surface border border-surface-200 p-4 rounded-xl text-base font-bold text-ink-900 focus:border-green-500 outline-hidden transition-colors" />
                                </div>
                            </div>

                            <div className="mb-10 bg-surface p-8 rounded-2xl border border-surface-200/70">
                                <label htmlFor="consult-prereqs" className="text-xs uppercase font-bold text-green-700 tracking-widest mb-3 block flex items-center gap-2"><ClipboardList size={14} /> Pre-Requisites / Inputs</label>
                                <textarea id="consult-prereqs" value={formData.preRequisites} onChange={e => setFormData({ ...formData, preRequisites: e.target.value })} className="w-full bg-surface border border-surface-200 p-5 rounded-xl text-sm font-medium text-ink-600 focus:border-green-500 resize-none custom-scroll outline-hidden transition-colors leading-relaxed" placeholder="Record reference materials, incident IDs, or data inputs required for this meeting..." disabled={!canEditForm} rows="3" maxLength={5000}></textarea>
                            </div>

                            <div className="grid grid-cols-1 lg:grid-cols-2 gap-10 mb-10">
                                {/* Attendees List */}
                                <div className="bg-surface p-8 rounded-2xl border border-surface-200/70 flex flex-col h-[500px]">
                                    <div className="flex justify-between items-center mb-6 border-b border-surface-200/70 pb-3">
                                        <h3 className="font-bold text-purple-700 uppercase text-xs tracking-widest flex items-center gap-2"><Users size={14} /> Attendance Roster <span className="bg-purple-100 text-ink-900 px-2 py-0.5 rounded border border-purple-500/50 text-[10px] ml-1">{(formData.attendees || []).length}</span></h3>
                                    </div>

                                    {canEditForm && (
                                        <div className="space-y-4 mb-6">
                                            <div>
                                                <span className="text-[10px] font-bold text-ink-400 uppercase tracking-widest block mb-2 ml-1">Internal Staff — Department · Employee</span>
                                                <div className="flex gap-2">
                                                    <div className="flex-1">
                                                        <DeptPersonPicker
                                                            users={siteUsers}
                                                            value={selectedUserToAdd}
                                                            onChange={(v) => setSelectedUserToAdd(v)}
                                                            getValue={(u) => u.name || u.email}
                                                            renderPerson={(u) => `${u.name || u.email} (${u.role})`}
                                                            personPlaceholder="Select Internal Employee..."
                                                            selectClass="w-full text-sm font-bold bg-surface border border-surface-200 rounded-xl p-3 focus:border-purple-500 text-ink-900 outline-hidden transition-colors"
                                                        />
                                                    </div>
                                                    <button type="button" onClick={() => handleAddAttendee('internal')} className="bg-purple-600 hover:bg-purple-500 text-white px-5 rounded-xl font-bold shadow-lg shadow-purple-600/20 transition-transform active:scale-95 whitespace-nowrap"><Plus size={16} className="inline" /></button>
                                                </div>
                                            </div>
                                            <div>
                                                <span className="text-[10px] font-bold text-ink-400 uppercase tracking-widest block mb-2 ml-1">External Contractor</span>
                                                <div className="flex gap-2">
                                                    <input value={externalName} onChange={e => setExternalName(e.target.value)} placeholder="Type Contractor Name..." maxLength={200} className="w-full text-sm font-bold bg-surface border border-surface-200 rounded-xl p-3 focus:border-pink-500 text-ink-900 outline-hidden transition-colors" />
                                                    <button type="button" onClick={() => handleAddAttendee('external')} className="bg-pink-600 hover:bg-pink-500 text-white px-5 rounded-xl font-bold shadow-lg shadow-pink-600/20 transition-transform active:scale-95 whitespace-nowrap"><Plus size={16} className="inline" /></button>
                                                </div>
                                            </div>
                                        </div>
                                    )}

                                    <div className="flex-1 overflow-y-auto custom-scroll border border-surface-200 rounded-xl bg-surface">
                                        <table className="w-full text-left text-sm text-ink-600">
                                            <thead className="bg-surface uppercase font-bold text-ink-400 text-[10px] tracking-widest sticky top-0 shadow-sm border-b border-surface-200/70">
                                                <tr><th className="p-4 pl-5">Name</th><th className="p-4">Role</th><th className="p-4 w-10 text-center"><span className="sr-only">Actions</span></th></tr>
                                            </thead>
                                            <tbody className="divide-y divide-surface-200/60">
                                                {(formData.attendees || []).map((att, idx) => (
                                                    <tr key={idx} className="hover:bg-surface-100 transition-colors">
                                                        <td className="p-4 pl-5 font-bold text-ink-900">
                                                            {att.name}
                                                            {att.userId === 'External' && <span className="ml-3 text-[9px] text-pink-600 bg-pink-100 px-2 py-1 rounded-lg font-bold uppercase tracking-widest border border-pink-500/30 shadow-sm">EXT</span>}
                                                        </td>
                                                        <td className="p-4 text-xs text-ink-500">{att.role}</td>
                                                        <td className="p-4 text-center">
                                                            {canEditForm && <button type="button" onClick={() => removeAttendee(idx)} className="text-red-600 hover:text-white bg-red-100 hover:bg-red-600 w-8 h-8 rounded-lg flex items-center justify-center transition-colors shadow-sm"><Trash2 size={16} /></button>}
                                                        </td>
                                                    </tr>
                                                ))}
                                                {(!formData.attendees || formData.attendees.length === 0) && <tr><td colSpan="3" className="p-10 text-center text-ink-400 italic text-sm border-2 border-dashed border-surface-200/70 rounded-xl m-4">No attendees added to roster.</td></tr>}
                                            </tbody>
                                        </table>
                                    </div>
                                </div>

                                {/* Minutes */}
                                <div className="bg-surface p-8 rounded-2xl border border-surface-200/70 flex flex-col h-[500px]">
                                    <label htmlFor="consult-minutes" className="text-xs uppercase font-bold text-green-700 tracking-widest mb-4 block border-b border-surface-200/70 pb-3 flex items-center gap-2"><MessagesSquare size={14} /> Official Discussion Minutes</label>
                                    <textarea id="consult-minutes" value={formData.minutes} onChange={e => setFormData({ ...formData, minutes: e.target.value })} className="w-full flex-1 bg-surface border border-surface-200 p-5 rounded-xl text-sm font-medium text-ink-900 focus:border-green-500 resize-none custom-scroll outline-hidden transition-colors leading-relaxed" placeholder="Record the general discussion points, topics covered, and any feedback received from participants here..." maxLength={5000} disabled={!canEditForm}></textarea>
                                </div>
                            </div>

                            {/* Action Plan (CAPA) */}
                            <div className="bg-surface p-8 rounded-2xl border border-blue-500/30 shadow-xl relative overflow-hidden">
                                <div className="absolute top-0 right-0 w-32 h-32 bg-blue-100 rounded-full blur-3xl pointer-events-none"></div>

                                <div className="flex justify-between items-center mb-6 border-b border-surface-200/70 pb-3 relative z-10">
                                    <span className="text-sm uppercase font-bold text-blue-600 tracking-widest flex items-center gap-2"><ListChecks size={16} /> Formulated Action Plan (CAPA)</span>
                                </div>

                                {canEditForm && (
                                    <div className="grid grid-cols-1 md:grid-cols-5 gap-4 mb-8 bg-surface p-5 rounded-xl border border-surface-200 relative z-10">
                                        <div className="md:col-span-2">
                                            <label htmlFor="consult-action-desc" className="text-[10px] uppercase font-bold text-ink-400 tracking-widest block mb-2 ml-1">Corrective Action Description</label>
                                            <input id="consult-action-desc" value={newActionLine.action} onChange={e => setNewActionLine({ ...newActionLine, action: e.target.value })} placeholder="What needs to be done?..." maxLength={500} className="w-full bg-surface border border-surface-200 p-3 rounded-xl text-sm text-ink-900 focus:border-blue-500 outline-hidden transition-colors" />
                                        </div>
                                        <div className="md:col-span-2">
                                            <span className="text-[10px] uppercase font-bold text-ink-400 tracking-widest block mb-2 ml-1">Responsible — department or person</span>
                                            <ActionOwnerField
                                                users={siteUsers}
                                                departments={departments}
                                                value={newActionLine}
                                                onChange={(owner) => setNewActionLine({ ...newActionLine, ...owner })}
                                                name="new-action-owner"
                                            />
                                        </div>
                                        <div className="md:col-span-2 flex items-end gap-3">
                                            <div className="flex-1">
                                                <label htmlFor="consult-action-due" className="text-[10px] uppercase font-bold text-ink-400 tracking-widest block mb-2 ml-1">Target Date</label>
                                                <input id="consult-action-due" type="date" value={newActionLine.due} onChange={e => setNewActionLine({ ...newActionLine, due: e.target.value })} className="w-full bg-surface border border-surface-200 p-3 rounded-xl text-sm font-mono text-ink-900 focus:border-blue-500 outline-hidden transition-colors" />
                                            </div>
                                            <button type="button" onClick={addAction} className="bg-blue-600 hover:bg-blue-500 text-white px-6 py-3 rounded-xl shadow-lg transition-transform active:scale-95 font-bold uppercase tracking-widest text-xs h-[46px] flex items-center justify-center gap-2"><Plus size={14} /> Add</button>
                                        </div>
                                    </div>
                                )}

                                <div className="overflow-x-auto rounded-xl border border-surface-200 shadow-2xl relative z-10 custom-scroll max-h-[400px]">
                                    <table className="w-full text-left text-sm whitespace-nowrap min-w-[800px]">
                                        <thead className="bg-surface text-[10px] uppercase font-bold text-ink-400 tracking-widest sticky top-0 z-20 shadow-sm border-b border-surface-200/70">
                                            <tr><th className="p-4 pl-6">Action Description</th><th className="p-4 w-1/4">Owner / Assignee</th><th className="p-4 w-40">Due Date</th><th className="p-4 w-40 text-center">Status</th><th className="p-4 w-16 text-center"><span className="sr-only">Actions</span></th></tr>
                                        </thead>
                                        <tbody className="divide-y divide-surface-200/60 bg-surface-50">
                                            {(formData.actions || []).map((c, i) => {
                                                const canEditRowStatus = canChangeActionStatus(c);
                                                return (
                                                    <tr key={i} className="hover:bg-surface-100 transition-colors">
                                                        <td className="p-3 pl-6">
                                                            <input aria-label={`Action ${i + 1} description`} value={c.action} onChange={e => updateAction(i, 'action', e.target.value)} placeholder="Task details..." maxLength={500} className="w-full bg-transparent border-b border-transparent hover:border-surface-200 focus:border-blue-500 text-sm font-medium px-2 py-1.5 outline-hidden text-ink-900 transition-colors" disabled={!canEditForm} />
                                                        </td>
                                                        <td className="p-3">
                                                            <ActionOwnerField
                                                                users={siteUsers}
                                                                departments={departments}
                                                                value={c}
                                                                disabled={!canEditForm}
                                                                name={`action-owner-${i}`}
                                                                onChange={(owner) => {
                                                                    const na = formData.actions.map((row, x) => (x === i ? { ...row, ...actionOwnerRecord(owner) } : row));
                                                                    setFormData({ ...formData, actions: na });
                                                                }}
                                                            />
                                                        </td>
                                                        <td className="p-3">
                                                            <input type="date" aria-label={`Due date for action ${i + 1}`} value={c.due} onChange={e => updateAction(i, 'due', e.target.value)} className="w-full bg-surface border border-surface-200 rounded-lg p-2 text-xs font-mono text-ink-900 outline-hidden focus:border-blue-500 transition-colors" disabled={!canEditForm} />
                                                        </td>
                                                        <td className="p-3 text-center">
                                                            <select aria-label={`Status of action ${i + 1}`} value={c.status} onChange={e => updateAction(i, 'status', e.target.value)} disabled={!canEditRowStatus} className={`w-full text-xs font-bold tracking-widest uppercase rounded-lg p-2 outline-hidden border transition-colors ${canEditRowStatus ? 'cursor-pointer' : 'cursor-not-allowed opacity-80'} ${c.status === 'Closed' ? 'bg-emerald-100 text-emerald-600 border-emerald-500/30 focus:border-emerald-500' : c.status === 'In Progress' ? 'bg-yellow-100 text-yellow-600 border-yellow-500/30 focus:border-yellow-500' : 'bg-surface text-ink-600 border-surface-200 focus:border-surface-300'}`}>
                                                                <option>Open</option><option>In Progress</option><option>Closed</option>
                                                            </select>
                                                        </td>
                                                        <td className="p-3 text-center">
                                                            {canEditForm && <button type="button" onClick={() => removeAction(i)} className="text-red-600 hover:text-white bg-red-100 hover:bg-red-600 w-8 h-8 rounded-lg flex items-center justify-center transition-colors shadow-sm"><Trash2 size={16} /></button>}
                                                        </td>
                                                    </tr>
                                                )
                                            })}
                                            {(!formData.actions || formData.actions.length === 0) && <tr><td colSpan="5" className="p-12 text-center text-ink-400 italic text-sm">No follow-up actions have been defined for this meeting.</td></tr>}
                                        </tbody>
                                    </table>
                                </div>
                            </div>

                            {canEditForm && (
                                <div className="flex justify-end mt-10 border-t border-surface-200/70 pt-8">
                                    <button type="button" onClick={saveRecord} disabled={saving} className="bg-gradient-to-r from-green-600 to-emerald-600 hover:from-green-500 hover:to-emerald-500 text-white font-bold py-4 px-12 rounded-xl shadow-lg shadow-green-900/50 transition-transform transform active:scale-95 flex items-center gap-3 uppercase tracking-widest text-sm">
                                        {saving ? <Loader2 size={18} className="animate-spin" /> : <Save size={18} />} Save Official Record
                                    </button>
                                </div>
                            )}
                        </div>
                    </div>
                )}

                {/* DETAIL VIEW MODAL */}
                {view === 'detail' && formData && (
                    <MeetingDetailModal meeting={formData} siteLabel={siteName(formData.siteId)} onClose={() => setView('list')} onUpdateStatus={quickStatusUpdate} onPrint={triggerPrint} session={session} permissions={permissions} />
                )}
            </div>

            {/* PRINT OVERLAY */}
            {printData && (
                <div className="meeting-minutes-print hidden print:block absolute inset-0 z-[9999]">
                    <MeetingMinutesDoc meeting={printData} siteLabel={siteName(printData.siteId)} />
                </div>
            )}
        </div>
    );
}
