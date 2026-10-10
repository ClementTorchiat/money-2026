import { useEffect, useState, useRef, Fragment, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, Tooltip as RechartsTooltip, ResponsiveContainer, CartesianGrid, Legend } from "recharts";
import { useVirtualizer } from '@tanstack/react-virtual';
import "./App.css";

type Account = {
  id: number;
  name: string;
  initial_balance: number;
}

type Transaction = {
  id: number;
  date: string;
  payee: string;
  category: string;
  check_number: string | null;
  amount: number;
  status: string | null;
  scheduleId?: number;
  runningBalance?: number;
};

type PayeeSuggestion = {
  name: string;
  category: string | null;
  amount: number | null;
};

type ScheduledTransaction = {
  id: number;
  payee: string;
  category: string;
  amount: number;
  frequency: string;
  next_due_date: string;
};

// Date utilities (Frontend: DD/MM/YYYY <-> Backend: YYYY-MM-DD)
const toFrenchDate = (isoDate: string) => {
  if (!isoDate || isoDate.length !== 10) return isoDate;
  const [y, m, d] = isoDate.split('-');
  return `${d}/${m}/${y}`;
};

const toIsoDate = (frenchDate: string) => {
  if (!frenchDate) return "";
  const parts = frenchDate.split('/');
  if (parts.length === 3) {
    return `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
  }
  return frenchDate; // fallback if malformed
};

const getTodayFrench = () => {
  const d = new Date();
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
};

const CheckIcon = ({ checked }: { checked: boolean }) => (
  <svg
    viewBox="0 0 24 24"
    className={`w-4 h-4 mx-auto rounded-full border transition-colors ${checked ? 'bg-blue-500 border-blue-500 text-white' : 'bg-transparent border-gray-300 text-transparent hover:border-blue-400'}`}
    fill="none"
    stroke="currentColor"
    strokeWidth="3"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <polyline points="20 6 9 17 4 12"></polyline>
  </svg>
);


function App() {
  const [account, setAccount] = useState<Account | null>(null);
  const [dbTransactions, setDbTransactions] = useState<Transaction[]>([]);
  const [scheduled, setScheduled] = useState<ScheduledTransaction[]>([]);
  const [loading, setLoading] = useState(true);

  // Tabs
  const [activeTab, setActiveTab] = useState<"comptes" | "echeances" | "dashboard">("comptes");

  // Search
  const [searchQuery, setSearchQuery] = useState("");
  const [showSearchFilters, setShowSearchFilters] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchBgRef = useRef<HTMLDivElement>(null);

  const renderHighlightedQuery = (query: string) => {
    if (!query) return null;
    const regex = /(date:|bénéficiaire:|catégorie:|montant:)/gi;
    const parts = query.split(regex);
    return parts.map((part, i) => {
      if (part.toLowerCase().match(/^(date:|bénéficiaire:|catégorie:|montant:)$/)) {
        return <span key={i} className="bg-gray-200 text-gray-700 rounded-sm">{part}</span>;
      }
      return <span key={i}>{part}</span>;
    });
  };
  const searchFilters = [
    { label: "Date", prefix: "date: " },
    { label: "Bénéficiaire", prefix: "bénéficiaire: " },
    { label: "Catégorie", prefix: "catégorie: " },
    { label: "Montant", prefix: "montant: " }
  ];
  // Selection state
  const [selectedTxId, setSelectedTxId] = useState<number | null>(null);
  const [selectedSchedule, setSelectedSchedule] = useState<ScheduledTransaction | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, tx: Transaction | null } | null>(null);

  useEffect(() => {
    const handleClick = () => setContextMenu(null);
    document.addEventListener("click", handleClick);
    return () => document.removeEventListener("click", handleClick);
  }, []);

  // Form State
  const [date, setDate] = useState("");
  const [payee, setPayee] = useState("");
  const [category, setCategory] = useState("");
  const [checkNumber, setCheckNumber] = useState("");
  const [debit, setDebit] = useState("");
  const [credit, setCredit] = useState("");
  const [frequency, setFrequency] = useState("MONTHLY");

  // Inline Edit State
  const [isEditing, setIsEditing] = useState(false);
  const [dateInput, setDateInput] = useState("");
  const [payeeValue, setPayeeValue] = useState("");
  const [categoryValue, setCategoryValue] = useState("");
  const [debitInput, setDebitInput] = useState("");
  const [creditInput, setCreditInput] = useState("");

  const localTodayIso = useMemo(() => toIsoDate(getTodayFrench()), []);
  const forecastIsoDate = useMemo(() => {
    return dbTransactions.length > 0
      ? dbTransactions.reduce((max, tx) => tx.date > max ? tx.date : max, dbTransactions[0].date)
      : localTodayIso;
  }, [dbTransactions, localTodayIso]);

  const sortedTransactions = useMemo(() => {
    let allTransactionsTemp = [...dbTransactions]
      .sort((a, b) => {
        // Sort by date ASC, then ID
        if (a.date !== b.date) return a.date.localeCompare(b.date);
        return a.id - b.id;
      });

    let _runningBalance = account?.initial_balance || 0;
    return allTransactionsTemp.map(tx => {
      _runningBalance += tx.amount;
      return { ...tx, runningBalance: _runningBalance };
    });
  }, [dbTransactions, scheduled, account?.initial_balance, localTodayIso]);

  const allTransactions = useMemo(() => {
    if (searchQuery.trim() && activeTab === "comptes") {
      const query = searchQuery.toLowerCase();

      const parseFilter = (prefix: string) => {
        const idx = query.indexOf(prefix);
        if (idx === -1) return null;
        const start = idx + prefix.length;
        const end = query.indexOf(':', start);
        if (end === -1) return query.slice(start).trim();
        const lastSpace = query.lastIndexOf(' ', end);
        return query.slice(start, lastSpace > start ? lastSpace : end).trim();
      };

      const catValue = parseFilter("catégorie:");
      const payeeValue = parseFilter("bénéficiaire:");
      const amountValue = parseFilter("montant:");
      const dateValue = parseFilter("date:");

      return sortedTransactions.filter(tx => {
        let match = true;
        if (catValue) match = match && tx.category.toLowerCase().includes(catValue);
        if (payeeValue) match = match && tx.payee.toLowerCase().includes(payeeValue);
        if (amountValue) match = match && Math.abs(tx.amount).toString().includes(amountValue);
        if (dateValue) match = match && toFrenchDate(tx.date).includes(dateValue);

        if (!catValue && !payeeValue && !amountValue && !dateValue) {
          match = tx.payee.toLowerCase().includes(query) ||
            tx.category.toLowerCase().includes(query) ||
            Math.abs(tx.amount).toString().includes(query);
        }
        return match;
      });
    }
    return sortedTransactions;
  }, [sortedTransactions, searchQuery, activeTab]);

  // Autocomplete
  const [suggestions, setSuggestions] = useState<PayeeSuggestion[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);

  // Refs for keyboard navigation
  const dateRef = useRef<HTMLInputElement>(null);
  const payeeRef = useRef<HTMLInputElement>(null);
  const categoryRef = useRef<HTMLInputElement>(null);
  const checkNumberRef = useRef<HTMLInputElement>(null);
  const debitRef = useRef<HTMLInputElement>(null);
  const creditRef = useRef<HTMLInputElement>(null);

  const fetchData = async () => {
    try {
      await invoke("process_due_scheduled_transactions");

      const acc = await invoke<Account>("get_account", { accountId: 1 });
      setAccount(acc);

      const txs = await invoke<Transaction[]>("get_transactions", { accountId: 1 });
      setDbTransactions(txs);

      if (!selectedTxId && activeTab === "comptes") {
        if (txs.length > 0 && !date) {
          setDate(toFrenchDate(txs[txs.length - 1].date));
        } else if (!date) {
          setDate(getTodayFrench());
        }
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const fetchScheduled = async () => {
    try {
      const sched = await invoke<ScheduledTransaction[]>("get_scheduled_transactions", { accountId: 1 });
      setScheduled(sched);
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    fetchData();
    fetchScheduled();
  }, []);

  useEffect(() => {
    const handleGlobalKeyDown = async (e: KeyboardEvent) => {
      // Ignore if typing in an input
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      if (activeTab === "comptes") {
        if (!selectedTxId && allTransactions.length > 0) {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            const firstValid = allTransactions[0];
            if (firstValid) selectTransaction(firstValid, false);
          }
          return;
        }

        const idx = allTransactions.findIndex(t => t.id === selectedTxId);
        if (idx !== -1) {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            let nextIdx = idx + 1;
            if (nextIdx < allTransactions.length) {
              selectTransaction(allTransactions[nextIdx], false);
            }
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            let prevIdx = idx - 1;
            if (prevIdx >= 0) {
              selectTransaction(allTransactions[prevIdx], false);
            }
          } else if (e.key === " ") {
            e.preventDefault();
            const tx = allTransactions[idx];
            if (tx) {
              await invoke("toggle_transaction_status", { txId: tx.id });
              fetchData();
            }
          } else if (e.key === "Backspace" || e.key === "Delete") {
            e.preventDefault();
            const tx = allTransactions[idx];
            if (tx) {
              await invoke("delete_transaction", { txId: tx.id });
              fetchData();
              setSelectedTxId(null);
              resetForm();
            }
          }
        }
      }
    };

    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, [selectedTxId, allTransactions, activeTab]);

  const handlePayeeChange = async (val: string) => {
    setPayee(val);
    if (val.length > 0) {
      try {
        const results = await invoke<PayeeSuggestion[]>("search_payees", { query: val });
        setSuggestions(results);
        setShowSuggestions(results.length > 0);
      } catch (e) {
        console.error(e);
        setSuggestions([]);
        setShowSuggestions(false);
      }
    } else {
      setSuggestions([]);
      setShowSuggestions(false);
    }
  };

  const applySuggestion = (s: PayeeSuggestion) => {
    setPayee(s.name);
    if (s.category) setCategory(s.category);
    if (s.amount !== null) {
      if (s.amount < 0) {
        setDebit(Math.abs(s.amount).toFixed(2));
        setCredit("");
      } else {
        setCredit(s.amount.toFixed(2));
        setDebit("");
      }
    }
    setShowSuggestions(false);
    categoryRef.current?.focus();
  };

  const handleKeyDown = async (
    e: React.KeyboardEvent<HTMLInputElement>,
    nextRef: React.RefObject<HTMLInputElement | null> | null,
    isSubmit = false,
    isPayee = false
  ) => {
    if (e.key === "Tab") {
      e.preventDefault();

      if (isPayee && showSuggestions && suggestions.length > 0) {
        applySuggestion(suggestions[0]);
      } else {
        nextRef?.current?.focus();
      }
    } else if (e.key === "Enter") {
      e.preventDefault();

      if (isPayee && showSuggestions && suggestions.length > 0) {
        applySuggestion(suggestions[0]);
        return;
      }

      if (isSubmit) {
        if (activeTab === "comptes") {
          await submitTransaction();
        } else if (activeTab === "echeances") {
          await submitSchedule();
        }
      } else {
        nextRef?.current?.focus();
      }
    }
  };

  const submitTransaction = async () => {
    if (!date || !payee || !category || (!debit && !credit)) return;

    const numDebit = parseFloat(debit.replace(',', '.'));
    const numCredit = parseFloat(credit.replace(',', '.'));
    const amount = (!isNaN(numDebit) && numDebit > 0) ? -Math.abs(numDebit) : (isNaN(numCredit) ? 0 : Math.abs(numCredit));

    if (amount === 0) return;

    try {
      await invoke("add_transaction", {
        payload: {
          account_id: 1,
          date: toIsoDate(date),
          payee,
          category,
          check_number: checkNumber || null,
          amount,
        }
      });

      setSelectedTxId(null);
      setPayee("");
      setCategory("");
      setCheckNumber("");
      setDebit("");
      setCredit("");
      setShowSuggestions(false);

      await fetchData();
      dateRef.current?.focus();
    } catch (e) {
      console.error("Failed to add transaction:", e);
    }
  };

  const handleSaveEdit = async (tx: Transaction) => {
    const numDebit = parseFloat(debitInput.replace(',', '.'));
    const numCredit = parseFloat(creditInput.replace(',', '.'));
    const amount = (!isNaN(numDebit) && numDebit > 0) ? -Math.abs(numDebit) : (isNaN(numCredit) ? 0 : Math.abs(numCredit));

    try {
      await invoke("update_transaction", {
        txId: tx.id,
        payload: {
          account_id: account?.id || 1,
          date: toIsoDate(dateInput),
          payee: payeeValue,
          category: categoryValue,
          check_number: tx.check_number,
          amount: amount,
          status: tx.status
        }
      });
      setIsEditing(false);
      await fetchData();
    } catch (e) {
      console.error("Failed to update transaction:", e);
    }
  };

  const deleteTransaction = async () => {
    if (!selectedTxId) return;
    try {
      await invoke("delete_transaction", { txId: selectedTxId });
      resetForm();
      await fetchData();
    } catch (e) {
      console.error("Failed to delete transaction:", e);
    }
  };

  const deleteSchedule = async () => {
    if (!selectedSchedule) return;
    try {
      await invoke("delete_scheduled_transaction", { scheduleId: selectedSchedule.id });
      resetForm();
      await fetchScheduled();
    } catch (e) {
      console.error("Failed to delete schedule:", e);
    }
  };



  const toggleStatus = async (e: React.MouseEvent, txId: number) => {
    e.stopPropagation();

    try {
      await invoke("toggle_transaction_status", { txId });
      await fetchData();
    } catch (err) {
      console.error("Failed to toggle status", err);
    }
  };

  const submitSchedule = async () => {
    if (!date || !payee || !category || (!debit && !credit)) return;

    const numDebit = parseFloat(debit.replace(',', '.'));
    const numCredit = parseFloat(credit.replace(',', '.'));
    const amount = (!isNaN(numDebit) && numDebit > 0) ? -Math.abs(numDebit) : (isNaN(numCredit) ? 0 : Math.abs(numCredit));

    if (amount === 0) return;

    try {
      if (selectedSchedule) {
        await invoke("update_scheduled_transaction", {
          scheduleId: selectedSchedule.id,
          payload: {
            account_id: 1,
            date: toIsoDate(date),
            payee,
            category,
            amount,
            frequency,
            next_due_date: toIsoDate(date),
          }
        });
      } else {
        await invoke("add_scheduled_transaction", {
          payload: {
            account_id: 1,
            date: toIsoDate(date),
            payee,
            category,
            amount,
            frequency,
            next_due_date: toIsoDate(date),
          }
        });
      }

      setPayee("");
      setCategory("");
      setDebit("");
      setCredit("");
      setDate(getTodayFrench());
      setShowSuggestions(false);
      setSelectedSchedule(null);

      await fetchData(); // Processes past due scheduled transactions and updates the account balance/transactions
      await fetchScheduled();
    } catch (e) {
      console.error("Failed to add schedule:", e);
    }
  };



  const selectTransaction = (tx: Transaction, focusInput = true) => {


    setSelectedTxId(tx.id);
    setDate(toFrenchDate(tx.date));
    setPayee(tx.payee);
    setCategory(tx.category);
    setCheckNumber(tx.check_number || "");
    if (tx.amount < 0) {
      setDebit(Math.abs(tx.amount).toFixed(2));
      setCredit("");
    } else {
      setCredit(tx.amount.toFixed(2));
      setDebit("");
    }
    setShowSuggestions(false);
    if (focusInput) {
      dateRef.current?.focus();
    }
  };

  const selectSchedule = (s: ScheduledTransaction) => {
    setSelectedSchedule(s);
    setDate(toFrenchDate(s.next_due_date));
    setPayee(s.payee);
    setCategory(s.category);
    setFrequency(s.frequency);
    if (s.amount < 0) {
      setDebit(Math.abs(s.amount).toFixed(2));
      setCredit("");
    } else {
      setCredit(s.amount.toFixed(2));
      setDebit("");
    }
    setShowSuggestions(false);
    if (s.amount < 0) {
      debitRef.current?.focus();
      debitRef.current?.select();
    } else {
      creditRef.current?.focus();
      creditRef.current?.select();
    }
  };

  const resetForm = () => {
    setSelectedTxId(null);
    setSelectedSchedule(null);
    setPayee("");
    setCategory("");
    setCheckNumber("");
    setDebit("");
    setCredit("");
    setDate(dbTransactions.length > 0 ? toFrenchDate(dbTransactions[dbTransactions.length - 1].date) : getTodayFrench());
    setFrequency("MONTHLY");
    setShowSuggestions(false);
    dateRef.current?.focus();
  };

  const fileInputRef = useRef<HTMLInputElement>(null);
  const fileDbInputRef = useRef<HTMLInputElement>(null);

  const handleDbUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!confirm("Voulez-vous vraiment remplacer la base de données actuelle par celle-ci ? Cette action est irréversible.")) {
      if (fileDbInputRef.current) fileDbInputRef.current.value = "";
      return;
    }

    setLoading(true);
    try {
      const buffer = await file.arrayBuffer();
      const uint8Array = new Uint8Array(buffer);
      // Tauri commands accept Vec<u8> as Array/Uint8Array from frontend
      await invoke("import_database", { dbBytes: Array.from(uint8Array) });
      
      // Reload everything
      await fetchData();
      await fetchScheduled();
      
      alert("Base de données importée avec succès !");
    } catch (err) {
      console.error("Error importing DB:", err);
      alert("Erreur lors de l'importation de la base de données.");
    } finally {
      setLoading(false);
      if (fileDbInputRef.current) {
        fileDbInputRef.current.value = "";
      }
    }
  };

  const handleQifUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !account) return;

    setLoading(true);
    try {
      const buffer = await file.arrayBuffer();
      // Decode using Windows-1252 to handle French accents correctly
      const decoder = new TextDecoder("windows-1252");
      const text = decoder.decode(buffer);

      const lines = text.split(/\r?\n/);
      const transactionsToImport = [];

      let currentTx: any = null;

      for (const line of lines) {
        if (line.startsWith('!Type:')) {
          continue;
        }

        if (line.startsWith('^')) {
          if (currentTx && currentTx.date && currentTx.amount !== undefined) {
            // Fill defaults
            if (!currentTx.payee) currentTx.payee = "Inconnu";
            if (!currentTx.category) currentTx.category = "Non catégorisé";
            transactionsToImport.push(currentTx);
          }
          currentTx = null;
          continue;
        }

        if (!currentTx) {
          currentTx = { account_id: account.id, check_number: null };
        }

        const type = line.charAt(0);
        const val = line.substring(1).trim();

        switch (type) {
          case 'D': // Date (e.g. 01/12'2001 or 01/12/2001)
            let dateStr = val.replace("'", "/");
            const parts = dateStr.split('/');
            if (parts.length === 3) {
              const d = parts[0].padStart(2, '0');
              const m = parts[1].padStart(2, '0');
              let y = parts[2];
              if (y.length === 2) {
                // If 2 digit year, make it 4 digits (assuming 1990-2089 range)
                y = (parseInt(y) > 80 ? '19' : '20') + y;
              }
              currentTx.date = `${y}-${m}-${d}`;
            }
            break;
          case 'T': // Amount
            // QIF amounts use commas as thousand separators and dots as decimals (e.g. 1,500.00)
            currentTx.amount = parseFloat(val.replace(/,/g, ''));
            break;
          case 'P': // Payee
            currentTx.payee = val;
            break;
          case 'L': // Category
            currentTx.category = val.replace(/:/g, ' - ');
            break;
          case 'N': // Check Number
            currentTx.check_number = val;
            break;
          case 'C': // Cleared Status
            if (val === '*' || val === 'X' || val === 'c' || val === 'R') {
              currentTx.status = 'P';
            }
            break;
        }
      }

      if (transactionsToImport.length > 0) {
        await invoke("import_transactions_batch", { accountId: account.id, transactions: transactionsToImport });
        await fetchData();
      }

    } catch (err) {
      console.error("Error importing QIF:", err);
      alert("Erreur lors de l'importation du fichier QIF.");
    } finally {
      setLoading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  };

  const handleTabChange = (tab: "comptes" | "echeances" | "dashboard") => {
    setActiveTab(tab);
    resetForm();
    if (tab === "echeances") {
      fetchScheduled();
    }
  };

  // Dashboard Aggregations
  const expensesByCategory = dbTransactions
    .filter(tx => tx.amount < 0)
    .reduce((acc: Record<string, number>, tx) => {
      acc[tx.category] = (acc[tx.category] || 0) + Math.abs(tx.amount);
      return acc;
    }, {});
  const pieData = Object.entries(expensesByCategory)
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value);
  const COLORS = ['#0088FE', '#00C49F', '#FFBB28', '#FF8042', '#8884d8', '#ffc658', '#4caf50', '#f44336'];

  const monthlyFlow = dbTransactions.reduce((acc: Record<string, { month: string, entrees: number, sorties: number }>, tx) => {
    const month = tx.date.substring(0, 7); // YYYY-MM
    if (!acc[month]) acc[month] = { month, entrees: 0, sorties: 0 };
    if (tx.amount > 0) acc[month].entrees += tx.amount;
    else acc[month].sorties += Math.abs(tx.amount);
    return acc;
  }, {});
  const barData = Object.values(monthlyFlow).sort((a, b) => a.month.localeCompare(b.month));

  // Balances calculation
  const initialBalance = account?.initial_balance || 0;

  // Solde de Prévision (Up to Forecast Date, includes projected)
  const soldePrevision = initialBalance + allTransactions.reduce((acc, tx) => acc + tx.amount, 0);

  // Solde Total (All transactions up to today)
  const soldeTotal = initialBalance + dbTransactions
    .filter(tx => tx.date <= localTodayIso)
    .reduce((acc, tx) => acc + tx.amount, 0);

  const firstFutureIndex = useMemo(() =>
    allTransactions.findIndex(tx => tx.date > localTodayIso),
    [allTransactions, localTodayIso]);

  const parentRef = useRef<HTMLDivElement>(null);

  const rowVirtualizer = useVirtualizer({
    count: allTransactions.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 35, // 34px row + 1px border
    overscan: 10,
  });

  // Auto-scroll to bottom on first load when data is available
  useEffect(() => {
    if (activeTab === "comptes" && allTransactions.length > 0 && !searchQuery) {
      // scroll to bottom (or to the first future index if it exists)
      const targetIndex = firstFutureIndex !== -1 ? firstFutureIndex : allTransactions.length - 1;
      // Slight delay to ensure DOM is ready
      setTimeout(() => {
        rowVirtualizer.scrollToIndex(targetIndex, { align: 'center' });
      }, 50);
    }
  }, [loading, activeTab, dbTransactions.length]); // depend on dbTransactions.length instead of allTransactions to prevent jumping while projecting

  const virtualItems = rowVirtualizer.getVirtualItems();
  const paddingTop = virtualItems.length > 0 ? virtualItems[0].start : 0;
  const paddingBottom = virtualItems.length > 0
    ? rowVirtualizer.getTotalSize() - virtualItems[virtualItems.length - 1].end
    : 0;

  return (
    <div className="flex flex-col h-screen bg-[#F5F5F7] text-[#1D1D1F] select-none text-[13px]" onClick={() => { setShowSuggestions(false); setShowSearchFilters(false); }}>
      {/* Context Menu */}
      {contextMenu && (
        <div
          className="fixed bg-white border border-gray-200 shadow-xl rounded-lg py-1 z-[9999] min-w-[180px] text-[13px] font-sans text-gray-800"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          {contextMenu.tx && (
            <>
              <button
                className="w-full text-left px-4 py-1.5 hover:bg-[#0068D6] hover:text-white"
                onClick={async () => {
                  await invoke("toggle_transaction_status", { txId: contextMenu.tx!.id });
                  fetchData();
                  setContextMenu(null);
                }}
              >
                Pointer / Dépointer
              </button>
              <button
                className="w-full text-left px-4 py-1.5 hover:bg-[#0068D6] hover:text-white"
                onClick={() => {
                  selectTransaction(contextMenu.tx!);
                  setSelectedTxId(contextMenu.tx!.id);
                  setIsEditing(true);
                  setDateInput(toFrenchDate(contextMenu.tx!.date));
                  setPayeeValue(contextMenu.tx!.payee);
                  setCategoryValue(contextMenu.tx!.category);
                  if (contextMenu.tx!.amount < 0) {
                    setDebitInput(Math.abs(contextMenu.tx!.amount).toFixed(2));
                    setCreditInput("");
                  } else {
                    setDebitInput("");
                    setCreditInput(contextMenu.tx!.amount.toFixed(2));
                  }
                  setContextMenu(null);
                }}
              >
                Éditer
              </button>
              <button
                className="w-full text-left px-4 py-1.5 hover:bg-[#0068D6] hover:text-white"
                onClick={() => {
                  selectTransaction(contextMenu.tx!);
                  setSelectedTxId(null);
                  setDate(getTodayFrench());
                  setContextMenu(null);
                }}
              >
                Dupliquer
              </button>
              <div className="h-px bg-gray-100 my-1"></div>
              <button
                className="w-full text-left px-4 py-1.5 hover:bg-red-500 hover:text-white text-red-600"
                onClick={async () => {
                  await invoke("delete_transaction", { txId: contextMenu.tx!.id });
                  fetchData();
                  if (selectedTxId === contextMenu.tx!.id) {
                    setSelectedTxId(null);
                    resetForm();
                  }
                  setContextMenu(null);
                }}
              >
                Supprimer
              </button>
            </>
          )}
        </div>
      )}

      {/* MAC HEADER / TOOLBAR */}
      <header className="relative h-[52px] bg-white border-b border-gray-200 flex items-center justify-between px-6 drag-region flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="font-semibold text-[15px]">{account ? account.name : "Money 2026"}</div>
          <input
            type="file"
            accept=".qif"
            ref={fileInputRef}
            onChange={handleQifUpload}
            className="hidden"
          />
          <input
            type="file"
            accept=".db,.sqlite"
            ref={fileDbInputRef}
            onChange={handleDbUpload}
            className="hidden"
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            className="text-[11px] font-medium px-2 py-1 bg-gray-100 hover:bg-gray-200 text-gray-600 rounded border border-gray-200 transition-colors"
            title="Importer depuis Money (Fichier QIF)"
          >
            Import QIF
          </button>
          <button
            onClick={() => fileDbInputRef.current?.click()}
            className="text-[11px] font-medium px-2 py-1 bg-gray-100 hover:bg-gray-200 text-gray-600 rounded border border-gray-200 transition-colors"
            title="Importer une base de données existante (.db)"
          >
            Import DB
          </button>
        </div>

        {/* Segmented Control */}
        <div className="absolute left-1/2 -translate-x-1/2 flex bg-gray-100 p-1 rounded-md border border-gray-200/60">
          <button
            onClick={() => handleTabChange("comptes")}
            className={`px-4 py-1 rounded-md text-sm transition-colors ${activeTab === 'comptes' ? 'bg-white shadow-sm font-medium text-black' : 'text-gray-500 hover:text-gray-700'}`}
          >
            Comptes
          </button>
          <button
            onClick={() => handleTabChange("echeances")}
            className={`px-4 py-1 rounded-md text-sm transition-colors flex items-center gap-2 ${activeTab === 'echeances' ? 'bg-white shadow-sm font-medium text-black' : 'text-gray-500 hover:text-gray-700'}`}
          >
            Échéances
          </button>
          <button
            onClick={() => handleTabChange("dashboard")}
            className={`px-4 py-1 rounded-md text-sm transition-colors ${activeTab === 'dashboard' ? 'bg-white shadow-sm font-medium text-black' : 'text-gray-500 hover:text-gray-700'}`}
          >
            Graphiques
          </button>
        </div>

        <div className="text-[12px] flex items-center gap-4 font-medium text-right leading-tight">
          <div className="text-gray-500 flex flex-col items-end">
            <div className="flex items-center gap-1">
              <span>Prévisionnel au</span>
              <span className="font-semibold text-gray-700">{toFrenchDate(forecastIsoDate)}</span>
            </div>
            <span className="text-black text-[13px] mt-0.5">{soldePrevision.toFixed(2)} €</span>
          </div>
          <div className="text-gray-500 border-l border-gray-300 pl-4 text-right">
            Total<br />
            <span className="text-black text-[13px] font-semibold mt-0.5 inline-block">{soldeTotal.toFixed(2)} €</span>
          </div>
        </div>
      </header>

      {/* MAIN VIEW */}
      <div className="flex-1 overflow-auto flex flex-col relative">
        {activeTab === "comptes" ? (
          <>
            <div className="bg-white border-b border-gray-200 px-6 py-2 flex items-center gap-4 z-20 flex-shrink-0">
              <div className="relative w-full max-w-md" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center bg-gray-100 rounded-md px-3 py-1.5 focus-within:ring-2 focus-within:ring-blue-500 focus-within:bg-white border border-transparent focus-within:border-gray-300 transition-all cursor-text relative" onClick={() => searchInputRef.current?.focus()}>
                  <svg className="w-4 h-4 text-gray-400 mr-2 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path></svg>

                  <div className="relative flex-1 h-[20px] flex items-center overflow-hidden font-mono text-[12px]">
                    {/* Background layer */}
                    <div
                      ref={searchBgRef}
                      className="absolute inset-0 whitespace-pre overflow-x-auto no-scrollbar pointer-events-none flex items-center text-gray-800"
                      aria-hidden="true"
                    >
                      {searchQuery ? renderHighlightedQuery(searchQuery) : <span className="text-gray-400 font-sans text-[13px]">Rechercher... (ex: catégorie: Alimentation)</span>}
                    </div>

                    {/* Foreground input */}
                    <input
                      ref={searchInputRef}
                      type="text"
                      value={searchQuery}
                      onChange={e => { setSearchQuery(e.target.value); setShowSearchFilters(e.target.value.length === 0 || e.target.value.endsWith(' ')); }}
                      onFocus={() => setShowSearchFilters(true)}
                      onScroll={e => { if (searchBgRef.current) searchBgRef.current.scrollLeft = e.currentTarget.scrollLeft; }}
                      className="absolute inset-0 bg-transparent border-none outline-none w-full text-transparent caret-black"
                      spellCheck={false}
                    />
                  </div>

                  {searchQuery && (
                    <button onClick={(e) => { e.stopPropagation(); setSearchQuery(''); searchInputRef.current?.focus(); }} className="text-gray-400 hover:text-gray-600 ml-2 z-10 relative">
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                    </button>
                  )}
                </div>

                {/* Search Filters Dropdown */}
                {showSearchFilters && (
                  <div className="absolute top-full left-0 mt-1 w-full bg-white border border-gray-200 rounded-md shadow-lg overflow-hidden z-[100]">
                    <div className="px-3 py-2 text-[11px] font-semibold text-gray-500 uppercase bg-gray-50 border-b border-gray-100">Filtres de recherche</div>
                    <ul className="max-h-48 overflow-y-auto">
                      {searchFilters.map((f, idx) => (
                        <li
                          key={idx}
                          onClick={() => {
                            setSearchQuery(prev => {
                              const base = prev.endsWith(' ') || prev.length === 0 ? prev : prev + ' ';
                              return base + f.prefix;
                            });
                            searchInputRef.current?.focus();
                            setShowSearchFilters(false);
                          }}
                          className="px-3 py-2 hover:bg-blue-50 cursor-pointer border-b border-gray-50 last:border-b-0 flex items-center"
                        >
                          <span className="font-medium text-gray-700 text-[13px]">{f.label}</span>
                          <span className="ml-2 text-[12px] text-gray-400 font-mono bg-gray-100 px-1.5 rounded">{f.prefix}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
              <div className="text-gray-400 text-[11px]">
                {allTransactions.length} transaction(s)
              </div>
            </div>

            <div className="flex-1 overflow-auto" ref={parentRef}>
              <table className="w-full text-left border-collapse table-fixed">
                <thead className="sticky top-0 bg-[#F5F5F7]/90 backdrop-blur-md z-10 border-b border-gray-200 shadow-sm">
                  <tr className="text-gray-500 text-[12px]">
                    <th className="font-medium py-2 px-4 border-r border-gray-200/50 w-24">Date</th>
                    <th className="font-medium py-2 px-4 border-r border-gray-200/50">Bénéficiaire</th>
                    <th className="font-medium py-2 px-4 border-r border-gray-200/50 w-[20%]">Catégorie</th>
                    <th className="font-medium py-2 px-4 border-r border-gray-200/50 w-24">N° Chèque</th>
                    <th className="font-medium py-2 px-2 border-r border-gray-200/50 w-10 text-center" title="Pointage">P.</th>
                    <th className="font-medium py-2 px-4 border-r border-gray-200/50 text-right w-24">Débit</th>
                    <th className="font-medium py-2 px-4 border-r border-gray-200/50 text-right w-24">Crédit</th>
                    <th className="font-medium py-2 px-4 text-right w-32">Solde</th>
                  </tr>
                </thead>
                <tbody>
                  {loading && <tr><td colSpan={8} className="text-center py-8 text-gray-400">Chargement...</td></tr>}
                  {!loading && paddingTop > 0 && <tr><td style={{ height: `${paddingTop}px` }} colSpan={8} /></tr>}
                  {!loading && virtualItems.map((virtualRow) => {
                    const index = virtualRow.index;
                    const tx = allTransactions[index];

                    const isSelected = selectedTxId === tx.id;
                    const isCleared = tx.status === 'P';
                    const showSeparator = index === firstFutureIndex;

                    return (
                      <Fragment key={tx.id}>
                        {showSeparator && (
                          <tr>
                            <td colSpan={8} className="h-[2px] bg-black p-0 border-0"></td>
                          </tr>
                        )}
                        {isEditing && selectedTxId === tx.id ? (
                          <tr
                            className="text-[11px] h-[31px] bg-[#fff5d0] border-b border-gray-200 outline outline-1 outline-blue-500 shadow-sm relative z-10"
                          >
                            <td className="py-1.5 px-2 text-center relative group">
                              <div className="absolute inset-y-0 left-0 w-1 bg-blue-500"></div>
                            </td>
                            <td className="py-1.5 px-4"><input type="text" value={dateInput} onChange={(e) => setDateInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') handleSaveEdit(tx); }} className="w-full bg-white border border-gray-300 rounded px-2 py-0.5" /></td>
                            <td className="py-1.5 px-4"><input type="text" value={payeeValue} onChange={(e) => setPayeeValue(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') handleSaveEdit(tx); }} className="w-full bg-white border border-gray-300 rounded px-2 py-0.5" /></td>
                            <td className="py-1.5 px-4"><input type="text" value={categoryValue} onChange={(e) => setCategoryValue(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') handleSaveEdit(tx); }} className="w-full bg-white border border-gray-300 rounded px-2 py-0.5" /></td>
                            <td className="py-1.5 px-4"></td>
                            <td className="py-1.5 px-2 text-center text-gray-500">{tx.status || ""}</td>
                            <td className="py-1.5 px-4"><input type="text" value={debitInput} onChange={(e) => setDebitInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') handleSaveEdit(tx); }} className="w-full bg-white border border-gray-300 rounded px-2 py-0.5 text-right text-red-500" /></td>
                            <td className="py-1.5 px-4"><input type="text" value={creditInput} onChange={(e) => setCreditInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') handleSaveEdit(tx); }} className="w-full bg-white border border-gray-300 rounded px-2 py-0.5 text-right text-green-600" /></td>
                            <td className="py-1.5 px-4 text-right font-medium text-gray-700">{tx.runningBalance?.toFixed(2)}</td>
                          </tr>
                        ) : (
                          <tr
                            data-index={index}
                            ref={rowVirtualizer.measureElement}
                            onClick={() => selectTransaction(tx)}
                            onDoubleClick={() => {
                              selectTransaction(tx);
                              setSelectedTxId(tx.id);
                              setIsEditing(true);
                              setDateInput(toFrenchDate(tx.date));
                              setPayeeValue(tx.payee);
                              setCategoryValue(tx.category);
                              if (tx.amount < 0) {
                                setDebitInput(Math.abs(tx.amount).toFixed(2));
                                setCreditInput("");
                              } else {
                                setDebitInput("");
                                setCreditInput(tx.amount.toFixed(2));
                              }
                            }}
                            onContextMenu={(e) => {
                              e.preventDefault();
                              setContextMenu({ x: e.clientX, y: e.clientY, tx });
                              selectTransaction(tx);
                            }}
                            className={`border-b border-gray-100 cursor-default ${isSelected ? 'bg-[#0068D6] text-white' : 'hover:bg-gray-100/50 bg-white'}`}
                          >
                            <td className="py-1.5 px-4 truncate">{toFrenchDate(tx.date)}</td>
                            <td className="py-1.5 px-4 truncate flex items-center gap-2">
                              {tx.scheduleId != null && (
                                <span className="inline-block bg-blue-100 text-blue-700 text-[9px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wider">
                                  ÉCHÉANCE
                                </span>
                              )}
                              {tx.payee}
                            </td>
                            <td className={`py-1.5 px-4 truncate ${isSelected ? 'text-blue-100' : 'text-gray-500'}`}>{tx.category}</td>
                            <td className={`py-1.5 px-4 truncate ${isSelected ? 'text-blue-100' : 'text-gray-500'}`}>{tx.check_number || ""}</td>

                            <td className="py-1.5 px-2 text-center" onClick={(e) => toggleStatus(e, tx.id)}>
                              <CheckIcon checked={isCleared} />
                            </td>

                            <td className={`py-1.5 px-4 text-right truncate ${isSelected ? 'text-white' : 'text-red-500'}`}>
                              {tx.amount < 0 ? Math.abs(tx.amount).toFixed(2) : ""}
                            </td>
                            <td className={`py-1.5 px-4 text-right truncate ${isSelected ? 'text-white' : 'text-green-600'}`}>
                              {tx.amount > 0 ? tx.amount.toFixed(2) : ""}
                            </td>
                            <td className={`py-1.5 px-4 text-right font-medium truncate ${isSelected ? 'text-white' : 'text-gray-800'}`}>
                              {tx.runningBalance?.toFixed(2)}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                  {!loading && paddingBottom > 0 && <tr><td style={{ height: `${paddingBottom}px` }} colSpan={8} /></tr>}
                </tbody>
              </table>
            </div>
          </>
        ) : activeTab === "dashboard" ? (
          <div className="p-6 h-full flex flex-col">
            <h2 className="text-lg font-semibold mb-6 text-gray-800">Tableau de bord</h2>
            <div className="flex flex-wrap gap-6 h-[400px]">
              {/* Card 1: Pie Chart */}
              <div className="flex-1 bg-white p-4 rounded-xl border border-gray-200 shadow-sm min-w-[300px] flex flex-col">
                <h3 className="text-[13px] font-semibold text-gray-500 uppercase tracking-wider mb-4">Dépenses par catégorie</h3>
                <div className="flex-1 min-h-0">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={pieData}
                        cx="50%"
                        cy="50%"
                        innerRadius={60}
                        outerRadius={100}
                        paddingAngle={5}
                        dataKey="value"
                      >
                        {pieData.map((_, index) => (
                          <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                        ))}
                      </Pie>
                      <RechartsTooltip formatter={(value: any) => typeof value === 'number' ? value.toFixed(2) + ' €' : value} />
                      <Legend />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Card 2: Bar Chart */}
              <div className="flex-[2] bg-white p-4 rounded-xl border border-gray-200 shadow-sm min-w-[400px] flex flex-col">
                <h3 className="text-[13px] font-semibold text-gray-500 uppercase tracking-wider mb-4">Flux de trésorerie mensuel</h3>
                <div className="flex-1 min-h-0">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={barData}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#E5E7EB" />
                      <XAxis dataKey="month" axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: '#6B7280' }} />
                      <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: '#6B7280' }} />
                      <RechartsTooltip formatter={(value: any) => typeof value === 'number' ? value.toFixed(2) + ' €' : value} cursor={{ fill: '#F3F4F6' }} />
                      <Legend />
                      <Bar dataKey="entrees" name="Entrées (+)" fill="#10B981" radius={[4, 4, 0, 0]} />
                      <Bar dataKey="sorties" name="Sorties (-)" fill="#EF4444" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="p-6">
            <h2 className="text-lg font-semibold mb-6 text-gray-800">Modèles d'échéances</h2>
            {scheduled.length === 0 ? (
              <div className="text-center py-10 text-gray-500 bg-white border border-gray-200 rounded-lg shadow-sm">
                Aucune échéance configurée.
              </div>
            ) : (
              <div className="flex gap-6">
                {/* DEBITS COLUMN */}
                <div className="flex-1">
                  <h3 className="text-[13px] font-semibold text-gray-500 uppercase tracking-wider mb-3">Débits (Prélèvements)</h3>
                  <div className="flex flex-col gap-3">
                    {scheduled.filter(s => s.amount < 0).map(s => {
                      const isSelected = selectedSchedule?.id === s.id;
                      return (
                        <div
                          key={s.id}
                          onClick={() => selectSchedule(s)}
                          className={`p-4 rounded-lg border cursor-pointer transition-all shadow-sm ${isSelected ? 'border-blue-500 ring-1 ring-blue-500 bg-blue-50' : 'border-gray-200 bg-white hover:border-blue-300 hover:shadow-md'}`}
                        >
                          <div className="flex justify-between items-start mb-2">
                            <div className="font-semibold text-[14px] text-gray-800">{s.payee}</div>
                            <div className="font-medium text-red-500">
                              {Math.abs(s.amount).toFixed(2)} €
                            </div>
                          </div>
                          <div className="text-gray-500 text-xs mb-3">{s.category}</div>
                          <div className="flex justify-between items-center pt-3 border-t border-gray-100">
                            <div className="text-[12px] font-medium text-blue-600 flex items-center gap-1.5">
                              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>
                              {s.frequency === 'MONTHLY' ? 'Tous les mois' : (s.frequency === 'WEEKLY' ? 'Toutes les semaines' : 'Tous les ans')}
                            </div>
                            <div className="text-gray-500 text-xs">
                              Prochaine : <span className="font-medium text-gray-700">{toFrenchDate(s.next_due_date)}</span>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* CREDITS COLUMN */}
                <div className="flex-1">
                  <h3 className="text-[13px] font-semibold text-gray-500 uppercase tracking-wider mb-3">Crédits (Virements reçus)</h3>
                  <div className="flex flex-col gap-3">
                    {scheduled.filter(s => s.amount >= 0).map(s => {
                      const isSelected = selectedSchedule?.id === s.id;
                      return (
                        <div
                          key={s.id}
                          onClick={() => selectSchedule(s)}
                          className={`p-4 rounded-lg border cursor-pointer transition-all shadow-sm ${isSelected ? 'border-blue-500 ring-1 ring-blue-500 bg-blue-50' : 'border-gray-200 bg-white hover:border-blue-300 hover:shadow-md'}`}
                        >
                          <div className="flex justify-between items-start mb-2">
                            <div className="font-semibold text-[14px] text-gray-800">{s.payee}</div>
                            <div className="font-medium text-green-600">
                              {s.amount.toFixed(2)} €
                            </div>
                          </div>
                          <div className="text-gray-500 text-xs mb-3">{s.category}</div>
                          <div className="flex justify-between items-center pt-3 border-t border-gray-100">
                            <div className="text-[12px] font-medium text-blue-600 flex items-center gap-1.5">
                              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>
                              {s.frequency === 'MONTHLY' ? 'Tous les mois' : (s.frequency === 'WEEKLY' ? 'Toutes les semaines' : 'Tous les ans')}
                            </div>
                            <div className="text-gray-500 text-xs">
                              Prochaine : <span className="font-medium text-gray-700">{toFrenchDate(s.next_due_date)}</span>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* BOTTOM FORM PANEL */}
      <div className="bg-[#F5F5F7] border-t border-gray-200 p-4 shadow-[0_-4px_10px_rgba(0,0,0,0.02)] flex-shrink-0 z-50">
        <div className="max-w-5xl mx-auto">
          {activeTab === "comptes" ? (
            <>
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-semibold text-gray-700">
                  {selectedTxId ? "Modifier la transaction" : "Nouvelle transaction"}
                </h3>
                {selectedTxId && (
                  <button onClick={resetForm} className="text-blue-500 hover:text-blue-600 text-xs font-medium">
                    + Nouvelle saisie
                  </button>
                )}
              </div>

              <div className="flex gap-3 items-end relative">
                <div className="flex-[0.8] space-y-1">
                  <label className="text-[11px] font-medium text-gray-500 uppercase tracking-wider">Date</label>
                  <input
                    ref={dateRef}
                    type="text"
                    value={date}
                    onChange={e => setDate(e.target.value)}
                    onKeyDown={e => handleKeyDown(e, payeeRef)}
                    className="w-full bg-white border border-gray-300 rounded-md px-3 py-1.5 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-shadow h-[34px]"
                    placeholder="JJ/MM/AAAA"
                  />
                </div>

                <div className="flex-[2] space-y-1 relative">
                  <label className="text-[11px] font-medium text-gray-500 uppercase tracking-wider">Bénéficiaire</label>

                  {/* Floating Autocomplete Dropdown */}
                  {showSuggestions && suggestions.length > 0 && (
                    <div className="absolute bottom-[40px] left-0 w-full bg-white border border-gray-200 rounded-md shadow-lg overflow-hidden z-[100]">
                      <ul className="max-h-48 overflow-y-auto">
                        {suggestions.map((s, idx) => (
                          <li
                            key={idx}
                            onClick={(e) => { e.stopPropagation(); applySuggestion(s); }}
                            className="px-3 py-2 hover:bg-blue-50 cursor-pointer border-b border-gray-50 last:border-b-0 flex justify-between items-center group"
                          >
                            <div>
                              <div className="font-medium text-gray-800 text-[13px]">{s.name}</div>
                              <div className="text-[11px] text-gray-500">{s.category || 'Aucune catégorie'}</div>
                            </div>
                            {s.amount !== null && (
                              <div className={`text-[12px] font-medium ${s.amount < 0 ? 'text-red-500' : 'text-green-600'}`}>
                                {s.amount.toFixed(2)} €
                              </div>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <input
                    ref={payeeRef}
                    type="text"
                    value={payee}
                    onChange={e => handlePayeeChange(e.target.value)}
                    onFocus={() => { if (suggestions.length > 0) setShowSuggestions(true); }}
                    onKeyDown={e => handleKeyDown(e, categoryRef, false, true)}
                    className="w-full bg-white border border-gray-300 rounded-md px-3 py-1.5 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-shadow relative z-20 h-[34px]"
                    placeholder="À qui / De qui"
                  />
                </div>

                <div className="flex-[1.5] space-y-1">
                  <label className="text-[11px] font-medium text-gray-500 uppercase tracking-wider">Catégorie</label>
                  <input
                    ref={categoryRef}
                    type="text"
                    value={category}
                    onChange={e => setCategory(e.target.value)}
                    onKeyDown={e => handleKeyDown(e, checkNumberRef)}
                    className="w-full bg-white border border-gray-300 rounded-md px-3 py-1.5 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-shadow h-[34px]"
                    placeholder="Ex: Alimentation"
                  />
                </div>

                <div className="flex-[0.8] space-y-1">
                  <label className="text-[11px] font-medium text-gray-500 uppercase tracking-wider">N° Chèque</label>
                  <input
                    ref={checkNumberRef}
                    type="text"
                    value={checkNumber}
                    onChange={e => setCheckNumber(e.target.value)}
                    onKeyDown={e => handleKeyDown(e, debitRef)}
                    className="w-full bg-white border border-gray-300 rounded-md px-3 py-1.5 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-shadow h-[34px]"
                    placeholder="Optionnel"
                  />
                </div>

                <div className="flex-1 space-y-1">
                  <label className="text-[11px] font-medium text-gray-500 uppercase tracking-wider">Débit (-)</label>
                  <input
                    ref={debitRef}
                    type="text"
                    value={debit}
                    onChange={e => setDebit(e.target.value)}
                    onKeyDown={e => handleKeyDown(e, creditRef)}
                    className="w-full bg-white border border-gray-300 rounded-md px-3 py-1.5 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-shadow text-right text-red-600 h-[34px]"
                  />
                </div>

                <div className="flex-1 space-y-1">
                  <label className="text-[11px] font-medium text-gray-500 uppercase tracking-wider">Crédit (+)</label>
                  <input
                    ref={creditRef}
                    type="text"
                    value={credit}
                    onChange={e => setCredit(e.target.value)}
                    onKeyDown={e => handleKeyDown(e, null, true)}
                    className="w-full bg-white border border-gray-300 rounded-md px-3 py-1.5 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-shadow text-right text-green-600 h-[34px]"
                  />
                </div>

                <div className="flex gap-2 h-[34px]">
                  <button
                    onClick={submitTransaction}
                    className="bg-blue-500 hover:bg-blue-600 text-white font-medium px-4 py-1.5 rounded-md transition-colors shadow-sm"
                  >
                    {selectedTxId ? "Enregistrer" : "Ajouter"}
                  </button>
                  {selectedTxId && (
                    <button
                      onClick={deleteTransaction}
                      className="bg-red-50 hover:bg-red-100 text-red-600 font-medium px-3 py-1.5 rounded-md transition-colors border border-red-200"
                    >
                      Supprimer
                    </button>
                  )}
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-semibold text-gray-700">
                  {selectedSchedule ? "Valider l'échéance sélectionnée" : "Nouvelle échéance"}
                </h3>
                {selectedSchedule && (
                  <button onClick={resetForm} className="text-blue-500 hover:text-blue-600 text-xs font-medium">
                    + Créer une nouvelle échéance
                  </button>
                )}
              </div>
              <div className="flex gap-3 items-end relative">
                {!selectedSchedule && (
                  <div className="flex-[0.8] space-y-1">
                    <label className="text-[11px] font-medium text-gray-500 uppercase tracking-wider">Répétition</label>
                    <select
                      value={frequency}
                      onChange={e => setFrequency(e.target.value)}
                      className="w-full bg-white border border-gray-300 rounded-md px-2 py-1.5 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-shadow text-[13px] h-[34px] appearance-none"
                    >
                      <option value="MONTHLY">Mensuel</option>
                      <option value="WEEKLY">Hebdo</option>
                      <option value="YEARLY">Annuel</option>
                    </select>
                  </div>
                )}

                <div className="flex-[0.8] space-y-1">
                  <label className="text-[11px] font-medium text-gray-500 uppercase tracking-wider">
                    {selectedSchedule ? "Paiement le" : "Prochaine le"}
                  </label>
                  <input
                    ref={dateRef}
                    type="text"
                    value={date}
                    onChange={e => setDate(e.target.value)}
                    onKeyDown={e => handleKeyDown(e, payeeRef)}
                    className="w-full bg-white border border-gray-300 rounded-md px-3 py-1.5 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-shadow h-[34px]"
                    placeholder="JJ/MM/AAAA"
                  />
                </div>

                <div className="flex-[2] space-y-1 relative">
                  <label className="text-[11px] font-medium text-gray-500 uppercase tracking-wider">Bénéficiaire</label>

                  {/* Floating Autocomplete Dropdown */}
                  {showSuggestions && suggestions.length > 0 && !selectedSchedule && (
                    <div className="absolute bottom-[40px] left-0 w-full bg-white border border-gray-200 rounded-md shadow-lg overflow-hidden z-[100]">
                      <ul className="max-h-48 overflow-y-auto">
                        {suggestions.map((s, idx) => (
                          <li
                            key={idx}
                            onClick={(e) => { e.stopPropagation(); applySuggestion(s); }}
                            className="px-3 py-2 hover:bg-blue-50 cursor-pointer border-b border-gray-50 last:border-b-0 flex justify-between items-center group"
                          >
                            <div>
                              <div className="font-medium text-gray-800 text-[13px]">{s.name}</div>
                              <div className="text-[11px] text-gray-500">{s.category || 'Aucune catégorie'}</div>
                            </div>
                            {s.amount !== null && (
                              <div className={`text-[12px] font-medium ${s.amount < 0 ? 'text-red-500' : 'text-green-600'}`}>
                                {s.amount.toFixed(2)} €
                              </div>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <input
                    ref={payeeRef}
                    type="text"
                    value={payee}
                    onChange={e => handlePayeeChange(e.target.value)}
                    onFocus={() => { if (suggestions.length > 0) setShowSuggestions(true); }}
                    onKeyDown={e => handleKeyDown(e, categoryRef, false, true)}
                    disabled={!!selectedSchedule}
                    className="w-full bg-white border border-gray-300 rounded-md px-3 py-1.5 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-shadow relative z-20 h-[34px] disabled:bg-gray-100"
                    placeholder="À qui / De qui"
                  />
                </div>

                <div className="flex-[1.5] space-y-1">
                  <label className="text-[11px] font-medium text-gray-500 uppercase tracking-wider">Catégorie</label>
                  <input
                    ref={categoryRef}
                    type="text"
                    value={category}
                    onChange={e => setCategory(e.target.value)}
                    onKeyDown={e => handleKeyDown(e, debitRef)}
                    disabled={!!selectedSchedule}
                    className="w-full bg-white border border-gray-300 rounded-md px-3 py-1.5 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-shadow h-[34px] disabled:bg-gray-100"
                    placeholder="Ex: Loyer"
                  />
                </div>

                <div className="flex-1 space-y-1">
                  <label className="text-[11px] font-medium text-gray-500 uppercase tracking-wider">Débit (-)</label>
                  <input
                    ref={debitRef}
                    type="text"
                    value={debit}
                    onChange={e => setDebit(e.target.value)}
                    onKeyDown={e => handleKeyDown(e, creditRef)}
                    className="w-full bg-white border border-gray-300 rounded-md px-3 py-1.5 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-shadow text-right text-red-600 h-[34px]"
                  />
                </div>

                <div className="flex-1 space-y-1">
                  <label className="text-[11px] font-medium text-gray-500 uppercase tracking-wider">Crédit (+)</label>
                  <input
                    ref={creditRef}
                    type="text"
                    value={credit}
                    onChange={e => setCredit(e.target.value)}
                    onKeyDown={e => handleKeyDown(e, null, true)}
                    className="w-full bg-white border border-gray-300 rounded-md px-3 py-1.5 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-shadow text-right text-green-600 h-[34px]"
                  />
                </div>

                <div className="flex gap-2 h-[34px]">
                  {!selectedSchedule ? (
                    <button
                      onClick={submitSchedule}
                      className="bg-blue-500 hover:bg-blue-600 text-white font-medium px-4 py-1.5 rounded-md transition-colors shadow-sm"
                    >
                      Ajouter
                    </button>
                  ) : (
                    <>
                      <button
                        onClick={submitSchedule}
                        className="bg-blue-500 hover:bg-blue-600 text-white font-medium px-4 py-1.5 rounded-md transition-colors shadow-sm"
                      >
                        Enregistrer
                      </button>
                      <button
                        onClick={() => {
                          setSelectedSchedule(null);
                          resetForm();
                        }}
                        className="bg-gray-100 hover:bg-gray-200 text-gray-700 font-medium px-4 py-1.5 rounded-md transition-colors shadow-sm"
                      >
                        Annuler
                      </button>
                    </>
                  )}
                  {selectedSchedule && (
                    <button
                      onClick={deleteSchedule}
                      className="bg-red-50 hover:bg-red-100 text-red-600 font-medium px-3 py-1.5 rounded-md transition-colors border border-red-200"
                    >
                      Supprimer
                    </button>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default App;
