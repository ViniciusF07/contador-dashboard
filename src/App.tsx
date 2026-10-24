import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@supabase/supabase-js";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Activity, Clock, Cpu, Database, Download, Hash, LayoutDashboard, Moon, Radar, Radio, ShieldCheck, Sun, Wifi, type LucideIcon } from "lucide-react";

// Somente a chave PUBLICAVEL. A leitura e limitada pelas policies (RLS) do banco.
const sb = createClient(import.meta.env.VITE_SUPABASE_URL ?? "", import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "");

type Ev = { id: number; event_id: string; device_id: string; occurred_at: string; count_total: number; wifi_rssi: number | null };
type St = { device_id: string; last_seen_at: string; last_event_at: string | null; wifi_rssi: number | null;
  count_total: number | null; firmware_version: string | null; pending_events: number };

const TZ = "America/Fortaleza";
const HEARTBEAT_MS = 60_000;               // firmware v3: heartbeat de 60 s
const OFFLINE_APOS_MS = HEARTBEAT_MS * 2.5; // tolera 2 heartbeats perdidos
const dia = (t: number | string) => new Date(t).toLocaleDateString("en-CA", { timeZone: TZ });
const hora = (t: string) => Number(new Date(t).toLocaleString("en-GB", { timeZone: TZ, hour: "2-digit", hourCycle: "h23" }));
const dh = (t: string) => new Date(t).toLocaleString("pt-BR", { timeZone: TZ, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const PERIODOS: Record<string, [string, number]> = { hoje: ["Hoje", 0], "24h": ["Últimas 24 h", 1], "7d": ["7 dias", 7], "14d": ["14 dias", 14], "30d": ["30 dias", 30] };
const PASSOS: [LucideIcon, string, string][] = [
  [Radar, "Sensor detecta", "O PIR percebe alguém passando pelo ponto marcado."],
  [Cpu, "ESP32 envia", "A placa manda o evento por Wi-Fi, com hora e local."],
  [ShieldCheck, "Função confere", "Um serviço na nuvem valida o dado antes de gravar."],
  [Database, "Banco guarda", "O evento entra no histórico, pronto para consulta."],
  [LayoutDashboard, "Painel mostra", "Esta página busca os números e monta os gráficos."],
];

export default function App() {
  const [evs, setEvs] = useState<Ev[]>([]);
  const [st, setSt] = useState<St | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [rt, setRt] = useState("conectando");
  const [aoVivo, setAoVivo] = useState(false);  // true so depois de receber um INSERT real
  const [agora, setAgora] = useState(Date.now());
  const [periodo, setPeriodo] = useState("14d");
  const [dias, setDias] = useState(14);
  const [cheio, setCheio] = useState(false);
  const [pag, setPag] = useState(0);
  const [tema, setTema] = useState<string>(() => { try { return localStorage.getItem("tema") ?? ""; } catch { return ""; } });

  useEffect(() => {
    if (tema) document.documentElement.dataset.theme = tema; else delete document.documentElement.dataset.theme;
    try { tema ? localStorage.setItem("tema", tema) : localStorage.removeItem("tema"); } catch { /* ignora */ }
  }, [tema]);
  const escuro = tema ? tema === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;

  const carregar = useCallback(async () => {
    const desde = new Date(Date.now() - 60 * 864e5).toISOString();
    const buscar = async () => {
      let todos: Ev[] = [];
      for (let p = 0; p < 10; p++) {
        const r = await sb.from("motion_events").select("id,event_id,device_id,occurred_at,count_total,wifi_rssi")
          .gte("occurred_at", desde).order("occurred_at", { ascending: false }).order("id", { ascending: false })
          .range(p * 1000, p * 1000 + 999);
        if (r.error) return { error: r.error, data: null, cheio: false };
        todos = todos.concat(r.data as Ev[]);
        if (r.data.length < 1000) return { error: null, data: todos, cheio: false };
      }
      return { error: null, data: todos, cheio: true };
    };
    const [e, s] = await Promise.all([
      buscar(),
      sb.from("device_status").select("*").order("last_seen_at", { ascending: false }).limit(1),
    ]);
    if (e.error || s.error) setErro((e.error ?? s.error)!.message);
    else {
      setErro(null);
      setCheio(e.cheio);
      setEvs(e.data as Ev[]);
      setSt((s.data as St[])[0] ?? null);
    }
    setCarregando(false);
  }, []);

  // Realtime: assina, deduplica por id e remove o canal ao sair (sem canais duplicados)
  useEffect(() => {
    carregar();
    const ch = sb.channel("iot")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "motion_events" }, (p) => {
        const n = p.new as Ev;
        setEvs((a) => (a.some((x) => x.id === n.id) ? a : [n, ...a].sort((x, y) => (x.occurred_at < y.occurred_at ? 1 : -1))));
        setAoVivo(true);
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "device_status" }, (p) => {
        if (p.new && "device_id" in p.new) setSt(p.new as St);
      })
      .subscribe((s) => setRt(s));
    return () => { sb.removeChannel(ch); };
  }, [carregar]);

  // Fallback: sem Realtime, consulta a cada 15 s
  useEffect(() => {
    if (rt === "SUBSCRIBED") return;
    const i = setInterval(carregar, 15_000);
    return () => clearInterval(i);
  }, [rt, carregar]);
  useEffect(() => { const i = setInterval(() => setAgora(Date.now()), 15_000); return () => clearInterval(i); }, []);

  const hoje = dia(agora);
  const doDia = useMemo(() => evs.filter((e) => dia(e.occurred_at) === hoje), [evs, hoje]);
  const ultimaHora = evs.filter((e) => agora - Date.parse(e.occurred_at) <= 3_600_000).length;
  const porHora = useMemo(() => Array.from({ length: 24 }, (_, h) => ({
    h: `${String(h).padStart(2, "0")}h`, n: doDia.filter((e) => hora(e.occurred_at) === h).length })), [doDia]);
  const porDia = useMemo(() => {
    const m = new Map<string, number>();
    evs.forEach((e) => { const k = dia(e.occurred_at); m.set(k, (m.get(k) ?? 0) + 1); });
    return Array.from({ length: dias }, (_, i) => {
      const a = dia(agora - (dias - 1 - i) * 864e5), b = dia(agora - (2 * dias - 1 - i) * 864e5);
      return { d: a.slice(8) + "/" + a.slice(5, 7), atual: m.get(a) ?? 0, anterior: m.get(b) ?? 0 };
    });
  }, [evs, agora, dias]);
  const totAtual = porDia.reduce((t, x) => t + x.atual, 0);
  const totAnt = porDia.reduce((t, x) => t + x.anterior, 0);
  const variacao = totAnt > 0 ? Math.round(((totAtual - totAnt) / totAnt) * 100) : null;
  const baixarCsv = () => {
    const ini = agora - dias * 864e5;
    const l = [["data_hora", "dispositivo", "evento", "total_no_momento", "wifi_dbm"]];
    evs.filter((e) => Date.parse(e.occurred_at) >= ini).reverse().forEach((e) =>
      l.push([dh(e.occurred_at), e.device_id, "Movimento detectado", String(e.count_total), e.wifi_rssi != null ? String(e.wifi_rssi) : ""]));
    const url = URL.createObjectURL(new Blob(["\ufeff" + l.map((x) => x.join(";")).join("\n")], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a"); a.href = url; a.download = `contador_iot_${dias}dias.csv`; a.click(); URL.revokeObjectURL(url);
  };

  const online = st ? agora - Date.parse(st.last_seen_at) < OFFLINE_APOS_MS : null;
  const ultimoEv = st?.last_event_at ?? evs[0]?.occurred_at ?? null;
  const [, diasTab] = PERIODOS[periodo];
  const limite = periodo === "hoje" ? Date.parse(hoje + "T00:00:00-03:00") : agora - diasTab * 864e5;
  const filtrados = evs.filter((e) => Date.parse(e.occurred_at) >= limite);
  const PAG = 10, paginas = Math.max(1, Math.ceil(filtrados.length / PAG));
  const pagina = Math.min(pag, paginas - 1);
  const modo = rt === "SUBSCRIBED"
    ? (aoVivo ? "Tempo real confirmado: recebeu um evento ao vivo" : "Realtime conectado, aguardando o primeiro evento ao vivo")
    : "Atualização periódica a cada 15 s (Realtime indisponível)";

  return (
    <div className="wrap">
      <header className="topo">
        <div>
          <div className="marca">
            <svg width="40" height="24" viewBox="0 0 40 24" fill="none" aria-hidden="true">
              {[13, 20, 27].map((cx) => <circle key={cx} cx={cx} cy="12" r="9.5" stroke="var(--t1)" strokeWidth="2.4" />)}
            </svg>
            <span>Fundamentos de Computação Embarcada e IoT · PIT</span>
          </div>
          <h1>Contador IoT</h1>
          <p>Movimentos detectados pelo sensor PIR, direto do banco de dados.</p>
        </div>
        <div className="acoes">
          <select value={dias} onChange={(e) => setDias(Number(e.target.value))} aria-label="Período dos gráficos">
            <option value={7}>Últimos 7 dias</option><option value={14}>Últimos 14 dias</option><option value={30}>Últimos 30 dias</option>
          </select>
          <button className="btn-tema" onClick={() => setTema(escuro ? "light" : "dark")} aria-label="Alternar tema">
            {escuro ? <Sun size={16} /> : <Moon size={16} />} {escuro ? "Tema claro" : "Tema escuro"}
          </button>
          <button className="principal btn-tema" onClick={baixarCsv}><Download size={15} /> Baixar CSV</button>
        </div>
      </header>

      <div className={"faixa" + (erro ? " erro" : "")} role="status">
        <span className={"ponto" + (!erro && rt === "SUBSCRIBED" ? " on" : "")} />
        {erro ? `Erro ao carregar: ${erro}. Confira o .env e as permissões (02_dashboard_leitura.sql).`
          : carregando ? "Carregando dados..." : modo}
      </div>

      <section className="tiles">
        <Tile icon={<Hash size={15} />} rot="Total acumulado (dispositivo)" val={st?.count_total ?? "—"} sub="Contador local; zera com o comando r" />
        <Tile icon={<Activity size={15} />} rot="Eventos hoje" val={evs.length || st ? doDia.length : "—"} sub="Fuso America/Fortaleza" />
        <Tile icon={<Activity size={15} />} rot="Eventos na última hora" val={evs.length || st ? ultimaHora : "—"} />
        <Tile icon={<Clock size={15} />} rot="Último evento" sm val={ultimoEv ? dh(ultimoEv) : "Nenhum ainda"} />
        <Tile icon={<Radio size={15} />} rot="Dispositivo" sm
          val={online === null ? "Desconhecido" : online ? "Online" : "Offline"}
          dot={online === null ? "" : online ? "on" : "off"}
          sub={st ? `Última comunicação: ${dh(st.last_seen_at)}` : "Nunca enviou dados"} />
        <Tile icon={<Wifi size={15} />} rot="Sinal Wi-Fi" sm val={st?.wifi_rssi != null ? `${st.wifi_rssi} dBm` : "—"}
          sub={st?.pending_events ? `${st.pending_events} evento(s) na fila do ESP32` : undefined} />
      </section>

      <section className="grade2">
        <div className="cartao">
          <h2>Eventos por hora (hoje)</h2>
          {doDia.length === 0 ? <p className="vazio">Sem eventos hoje.</p> : <Grafico rotulo="Gráfico de barras: eventos por hora, hoje" data={porHora} x="h" barras={[{ k: "n", nome: "Eventos", cor: "var(--c1)" }]} />}
        </div>
        <div className="cartao">
          <h2>Eventos por dia ({dias} dias)</h2>
          {totAtual === 0 ? <p className="vazio">Sem eventos no período.</p> : <Grafico rotulo={`Gráfico de barras: eventos por dia, ${dias} dias`} data={porDia} x="d" barras={[{ k: "atual", nome: "Eventos", cor: "var(--c1)" }]} />}
        </div>
      </section>

      <section className="cartao" style={{ marginBottom: 14 }}>
        <h2>Comparação de períodos</h2>
        {totAnt === 0 ? <p className="vazio">Ainda não há eventos nos {dias} dias anteriores. A comparação aparece quando houver histórico nos dois períodos.</p> : (<>
          <p className="resumo"><b>{totAtual}</b> eventos nos últimos {dias} dias contra <b>{totAnt}</b> nos {dias} dias anteriores{variacao !== null && <> ({variacao > 0 ? "+" : ""}{variacao}%)</>}.</p>
          <Grafico rotulo={`Gráfico de barras: comparação dos últimos ${dias} dias com os ${dias} dias anteriores`} data={porDia} x="d" barras={[{ k: "atual", nome: `Últimos ${dias} dias`, cor: "var(--c1)" }, { k: "anterior", nome: `${dias} dias anteriores`, cor: "var(--c3)" }]} />
        </>)}
      </section>

      <section className="cartao">
        <div className="filtros">
          <h2 style={{ margin: 0 }}>Eventos recentes</h2>
          <select value={periodo} onChange={(e) => { setPeriodo(e.target.value); setPag(0); }} aria-label="Período">
            {Object.entries(PERIODOS).map(([k, [nome]]) => <option key={k} value={k}>{nome}</option>)}
          </select>
        </div>
        {filtrados.length === 0 ? <p className="vazio">Nenhum evento neste período.</p> : (
          <div className="rolagem"><table role="table">
            <thead role="rowgroup"><tr role="row"><th role="columnheader">Data e hora</th><th role="columnheader">Dispositivo</th><th role="columnheader">Evento</th><th role="columnheader">Total no momento</th><th role="columnheader">Wi-Fi</th></tr></thead>
            <tbody role="rowgroup">{filtrados.slice(pagina * PAG, pagina * PAG + PAG).map((e) => (
              <tr role="row" key={e.id}><td role="cell" data-label="Data e hora">{dh(e.occurred_at)}</td><td role="cell" data-label="Dispositivo">{e.device_id}</td><td role="cell" data-label="Evento">Movimento detectado</td>
                <td role="cell" data-label="Total no momento">{e.count_total}</td><td role="cell" data-label="Wi-Fi">{e.wifi_rssi != null ? `${e.wifi_rssi} dBm` : "—"}</td></tr>))}
            </tbody></table></div>
        )}
        <div className="pag">
          <button disabled={pagina === 0} onClick={() => setPag(pagina - 1)}>Anterior</button>
          <span>Página {pagina + 1} de {paginas} ({filtrados.length} eventos)</span>
          <button disabled={pagina >= paginas - 1} onClick={() => setPag(pagina + 1)}>Próxima</button>
        </div>
      </section>

      {cheio && <p className="faixa erro" style={{ marginTop: 14 }}>Exibindo apenas os 10.000 eventos mais recentes dos últimos 60 dias.</p>}

      <section className="cartao" style={{ marginTop: 14 }}>
        <h2>Como o sistema funciona</h2>
        <p className="sub2">Do sensor até a tela, sem intervenção manual.</p>
        <div className="fluxo">
          {PASSOS.map(([Ic, t, x], i) => (
            <Fragment key={t}>
              <div className="fluxo-passo"><div className="fluxo-icone"><Ic size={22} /></div><strong>{t}</strong><p>{x}</p></div>
              {i < PASSOS.length - 1 && <span className="fluxo-seta" aria-hidden="true">→</span>}
            </Fragment>
          ))}
        </div>
      </section>

      <footer className="rodape">
        <strong>Ruan, Ryan, Sâmio e Vinícius</strong> · Fundamentos de Computação Embarcada e IoT<br />
        Faculdade Estadual PIT, Piauí Instituto de Tecnologia
      </footer>
    </div>
  );
}

function Tile(p: { icon: React.ReactNode; rot: string; val: React.ReactNode; sub?: string; sm?: boolean; dot?: string }) {
  return (
    <div className="tile">
      <div className="rot">{p.icon}{p.rot}</div>
      <div className={"val" + (p.sm ? " sm" : "")}>{p.dot !== undefined && <span className={"ponto " + p.dot} style={{ display: "inline-block", marginRight: 8 }} />}{p.val}</div>
      {p.sub && <div className="sub">{p.sub}</div>}
    </div>
  );
}

function useLargura<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver(([c]) => setW(Math.round(c.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

// Largura mínima (px) reservada por rótulo do eixo X; define quantos rótulos cabem sem se sobrepor.
function Grafico(p: { data: object[]; x: string; barras: { k: string; nome: string; cor: string }[]; rotulo: string }) {
  const [ref, w] = useLargura<HTMLDivElement>();
  const estreito = w > 0 && w < 480;
  const area = Math.max(w - 40, 1);
  const cabem = Math.max(1, Math.floor(area / (p.x === "h" ? 36 : 46)));
  const intervalo = Math.max(0, Math.ceil(p.data.length / cabem) - 1);
  const reduzir = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  return (
    <div ref={ref} className="grafico" role="img" aria-label={p.rotulo}>
      {w > 0 && <ResponsiveContainer width="100%" height="100%">
        <BarChart data={p.data} margin={{ top: 4, right: estreito ? 4 : 8, left: 0, bottom: 0 }} barCategoryGap={p.data.length > 14 ? "12%" : "20%"}>
          <CartesianGrid stroke="var(--grid)" vertical={false} />
          <XAxis dataKey={p.x} stroke="var(--base)" tick={{ fontSize: estreito ? 10.5 : 11 }} interval={intervalo} tickMargin={4} />
          <YAxis width={estreito ? 28 : 34} allowDecimals={false} stroke="var(--base)" tick={{ fontSize: estreito ? 10.5 : 11 }} />
          <Tooltip contentStyle={{ background: "var(--s-1)", border: "1px solid var(--base)", borderRadius: 8, color: "var(--t1)", fontSize: 13 }} />
          {p.barras.length > 1 && <Legend wrapperStyle={{ fontSize: estreito ? 12 : 13 }} />}
          {p.barras.map((b) => <Bar key={b.k} dataKey={b.k} name={b.nome} fill={b.cor} radius={[4, 4, 0, 0]} isAnimationActive={!reduzir} />)}
        </BarChart>
      </ResponsiveContainer>}
    </div>
  );
}
