import React, { useEffect, useState } from "react";
import "./App.css";
import { create } from "kubo-rpc-client";
import { ethers } from "ethers";
import { Buffer } from "buffer";

import logo from "./ethereumLogo.png";
import { addresses, abis } from "./contracts";

const ZERO_ADDRESS =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

const defaultProvider = new ethers.providers.Web3Provider(window.ethereum, "any");

const ipfsContract = new ethers.Contract(
  addresses.ipfs,
  abis.ipfs,
  defaultProvider
);

const tenderContract = new ethers.Contract(
  addresses.publicTender,
  abis.publicTender,
  defaultProvider
);

// Lee el último fichero asociado al usuario en IpfsStorage
async function readCurrentUserFile() {
  const signer = defaultProvider.getSigner();
  const userAddress = await signer.getAddress();
  const result = await ipfsContract.userFiles(userAddress);
  console.log({ result });
  return result;
}

// Convierte el status numérico del contrato a texto
function statusToLabel(status) {
  switch (Number(status)) {
    case 0:
      return "Abierta";
    case 1:
      return "Cerrada";
    case 2:
      return "Evaluada";
    case 3:
      return "Finalizada";
    default:
      return "Desconocido";
  }
}

function App() {
  const [account, setAccount] = useState(null);
  const [role, setRole] = useState(null); // owner | evaluator | provider
  const [tenders, setTenders] = useState([]);
  const [activeTab, setActiveTab] = useState("tenders");

  // IPFS / oferta
  const [file, setFile] = useState(null);
  const [ipfsHash, setIpfsHash] = useState("");
  const [loading, setLoading] = useState(false);
  const [statusMsg, setStatusMsg] = useState("");
  const [errorMsg, setErrorMsg] = useState("");

  // Formularios
  const [newTender, setNewTender] = useState({
    description: "",
    maxPrice: "",
    deadlineDays: "",
    weightPrice: "",
    weightQuality: "",
  });

  const [offerForm, setOfferForm] = useState({
    tenderId: "",
    price: "",
  });

  const [evaluationForm, setEvaluationForm] = useState({
    tenderId: "",
    provider: "",
    qualityScore: "",
  });

  const [evaluatorAddr, setEvaluatorAddr] = useState("");

  // ====== INIT: conectar wallet, detectar rol, cargar licitaciones, leer IPFS previo ======
  useEffect(() => {
    const init = async () => {
      try {
        if (!window.ethereum) {
          setErrorMsg("MetaMask no está disponible en este navegador.");
          return;
        }

        const accounts = await window.ethereum.request({
          method: "eth_requestAccounts",
        });

        if (!accounts || accounts.length === 0) {
          setErrorMsg("No se ha encontrado ninguna cuenta en MetaMask.");
          return;
        }

        const acc = accounts[0];
        setAccount(acc);

        // Detectar rol
        const [ownerAddr, isEval] = await Promise.all([
          tenderContract.owner(),
          tenderContract.isEvaluator(acc),
        ]);

        if (acc.toLowerCase() === ownerAddr.toLowerCase()) {
          setRole("owner");
        } else if (isEval) {
          setRole("evaluator");
        } else {
          setRole("provider");
        }

        // Cargar licitaciones
        await loadTenders();

        // Leer último archivo guardado en IpfsStorage
        const fileOnChain = await readCurrentUserFile();
        if (fileOnChain && fileOnChain !== ZERO_ADDRESS) {
          setIpfsHash(fileOnChain);
        }
      } catch (err) {
        console.error(err);
        setErrorMsg("Error inicializando la dApp. Revisa MetaMask y la red.");
      }
    };

    init();
  }, []);

  // Cargar licitaciones desde el contrato
  const loadTenders = async () => {
  try {
    const count = await tenderContract.tenderCount();
    const total = Number(count);

    if (total === 0) {
      setTenders([]);
      return;
    }

    const loaded = [];

    // las licitaciones empiezan en ID = 1
    for (let i = 1; i <= total; i++) {
      try {
        const t = await tenderContract.getTender(i);
        loaded.push({
          id: i,
          description: t.description,
          maxPrice: t.maxPrice,
          deadline: t.deadline,
          status: t.status,
          winner: t.winner,
          participantCount: t.participantCount,
        });
      } catch (err) {
        console.warn("Saltando licitación", i, err);
        // Si alguna id intermedia no existe, la ignoramos
      }
    }

    setTenders(loaded);
  } catch (err) {
    console.error("Error cargando licitaciones:", err);
    setErrorMsg("No se pudieron cargar las licitaciones.");
  }
};

  // ====== IPFS + oferta ======
  const retrieveFile = (e) => {
    const data = e.target.files[0];
    if (!data) return;

    const reader = new window.FileReader();
    reader.readAsArrayBuffer(data);

    reader.onloadend = () => {
      const bufferData = Buffer(reader.result);
      console.log("Buffer data: ", bufferData);
      setFile(bufferData);
    };

    e.preventDefault();
  };

  async function setFileIPFS(hash) {
    const signer = defaultProvider.getSigner();
    const ipfsWithSigner = ipfsContract.connect(signer);
    console.log("TX IpfsStorage");
    const tx = await ipfsWithSigner.setFileIPFS(hash);
    console.log({ tx });
    setIpfsHash(hash);
  }

  const handleOfferSubmit = async (e) => {
    e.preventDefault();
    setErrorMsg("");
    setStatusMsg("");

    if (!offerForm.tenderId || !offerForm.price || !file) {
      setErrorMsg("Rellena tenderId, precio y selecciona un fichero.");
      return;
    }

    try {
      setLoading(true);
      setStatusMsg("Subiendo archivo a IPFS...");

      // conectar a IPFS local (Docker)
      const client = create("/ip4/127.0.0.1/tcp/5001");

      // añadir el archivo a IPFS
      const result = await client.add(file);

      // añadir al FS del nodo para verlo en el dashboard
      await client.files.cp(`/ipfs/${result.cid}`, `/${result.cid}`);
      console.log("CID:", result.cid);

      const cid = result.cid.toString();
      setIpfsHash(cid);

      setStatusMsg("Archivo subido a IPFS. Guardando CID en contratos...");

      const signer = defaultProvider.getSigner();
      const tenderWithSigner = tenderContract.connect(signer);

      // Guardar CID en IpfsStorage (opcional, para la práctica)
      await setFileIPFS(cid);

      // Enviar oferta al contrato de licitaciones
      const tenderIdBN = ethers.BigNumber.from(offerForm.tenderId);
      const priceBN = ethers.BigNumber.from(offerForm.price); // se asume precio en unidades enteras

      const tx = await tenderWithSigner.submitOffer(
        tenderIdBN,
        priceBN,
        cid // hash de la documentación
      );

      console.log("TX submitOffer:", tx.hash);

      setStatusMsg(
        `Oferta enviada. CID guardado y transacción enviada: ${tx.hash.slice(
          0,
          10
        )}...`
      );
    } catch (error) {
      console.error(error);
      setErrorMsg(error.message || "Error al enviar la oferta.");
    } finally {
      setLoading(false);
    }
  };

  // ====== Crear licitación ======
  const handleCreateTender = async (e) => {
    e.preventDefault();
    setErrorMsg("");
    setStatusMsg("");

    const { description, maxPrice, deadlineDays, weightPrice, weightQuality } =
      newTender;

    if (
      !description ||
      !maxPrice ||
      !deadlineDays ||
      !weightPrice ||
      !weightQuality
    ) {
      setErrorMsg("Rellena todos los campos de la licitación.");
      return;
    }

    try {
      setLoading(true);
      const signer = defaultProvider.getSigner();
      const tenderWithSigner = tenderContract.connect(signer);

      const tx = await tenderWithSigner.addTender(
        description,
        ethers.BigNumber.from(maxPrice),
        ethers.BigNumber.from(deadlineDays),
        Number(weightPrice),
        Number(weightQuality)
      );

      console.log("TX addTender:", tx.hash);
      setStatusMsg(
        `Licitación creada. Transacción enviada: ${tx.hash.slice(0, 10)}...`
      );

      // limpiar formulario
      setNewTender({
        description: "",
        maxPrice: "",
        deadlineDays: "",
        weightPrice: "",
        weightQuality: "",
      });

      // recargar licitaciones
      await loadTenders();
    } catch (err) {
      console.error(err);
      setErrorMsg(err.message || "Error al crear licitación.");
    } finally {
      setLoading(false);
    }
  };

  // ====== Evaluar oferta ======
  const handleEvaluate = async (e) => {
    e.preventDefault();
    setErrorMsg("");
    setStatusMsg("");

    const { tenderId, provider, qualityScore } = evaluationForm;

    if (!tenderId || !provider || !qualityScore) {
      setErrorMsg("Rellena tenderId, dirección del proveedor y puntuación.");
      return;
    }

    try {
      setLoading(true);
      const signer = defaultProvider.getSigner();
      const tenderWithSigner = tenderContract.connect(signer);

      const tx = await tenderWithSigner.evaluateOffer(
        ethers.BigNumber.from(tenderId),
        provider,
        Number(qualityScore)
      );

      console.log("TX evaluateOffer:", tx.hash);
      setStatusMsg(
        `Oferta evaluada. Transacción: ${tx.hash.slice(0, 10)}...`
      );
    } catch (err) {
      console.error(err);
      setErrorMsg(err.message || "Error al evaluar la oferta.");
    } finally {
      setLoading(false);
    }
  };

  const handleCalculateWinner = async (tenderId) => {
    setErrorMsg("");
    setStatusMsg("");

    try {
      setLoading(true);
      const signer = defaultProvider.getSigner();
      const tenderWithSigner = tenderContract.connect(signer);

      const tx = await tenderWithSigner.calculateWinner(
        ethers.BigNumber.from(tenderId)
      );

      console.log("TX calculateWinner:", tx.hash);
      setStatusMsg(
        `Ganador calculado. Transacción: ${tx.hash.slice(0, 10)}...`
      );
      await loadTenders();
    } catch (err) {
      console.error(err);
      setErrorMsg(err.message || "Error al calcular ganador.");
    } finally {
      setLoading(false);
    }
  };

  // ====== Gestión de evaluadores ======
  const handleAddEvaluator = async (e) => {
    e.preventDefault();
    setErrorMsg("");
    setStatusMsg("");

    if (!evaluatorAddr) {
      setErrorMsg("Introduce la dirección del evaluador.");
      return;
    }

    try {
      setLoading(true);
      const signer = defaultProvider.getSigner();
      const tenderWithSigner = tenderContract.connect(signer);

      const tx = await tenderWithSigner.addEvaluator(evaluatorAddr);
      console.log("TX addEvaluator:", tx.hash);
      setStatusMsg(
        `Evaluador añadido. Transacción: ${tx.hash.slice(0, 10)}...`
      );
      setEvaluatorAddr("");
    } catch (err) {
      console.error(err);
      setErrorMsg(err.message || "Error al añadir evaluador.");
    } finally {
      setLoading(false);
    }
  };

  const handleRemoveEvaluator = async (e) => {
    e.preventDefault();
    setErrorMsg("");
    setStatusMsg("");

    if (!evaluatorAddr) {
      setErrorMsg("Introduce la dirección del evaluador.");
      return;
    }

    try {
      setLoading(true);
      const signer = defaultProvider.getSigner();
      const tenderWithSigner = tenderContract.connect(signer);

      const tx = await tenderWithSigner.removeEvaluator(evaluatorAddr);
      console.log("TX removeEvaluator:", tx.hash);
      setStatusMsg(
        `Evaluador eliminado. Transacción: ${tx.hash.slice(0, 10)}...`
      );
      setEvaluatorAddr("");
    } catch (err) {
      console.error(err);
      setErrorMsg(err.message || "Error al eliminar evaluador.");
    } finally {
      setLoading(false);
    }
  };

  // ====== Render ======
  const renderRoleBadge = () => {
    if (!role) return null;
    if (role === "owner") {
      return <span className="role-badge role-owner">Propietario</span>;
    }
    if (role === "evaluator") {
      return <span className="role-badge role-evaluator">Evaluador</span>;
    }
    return <span className="role-badge role-provider">Proveedor</span>;
  };

  return (
    <div className="App">
      <div className="container">
        {/* CABECERA */}
        <div className="header">
          <div className="header-title">
            <div className="network-badge">
              <span>Public Tender + IPFS</span>
            </div>
            <h1>Gestor de licitaciones públicas</h1>
            <p>
              Crea licitaciones, envía ofertas con documentación en IPFS y
              evalúa propuestas usando smart contracts.
            </p>
          </div>

          <div className="wallet-status">
            <span className="status-pill">
              {account
                ? `Wallet: ${account.slice(0, 6)}...${account.slice(-4)}`
                : "Wallet no conectada"}
            </span>
            {renderRoleBadge()}
          </div>
        </div>

        {/* ALERTAS GLOBALES */}
        {(statusMsg || errorMsg) && (
          <div id="alertContainer">
            {statusMsg && <div className="alert alert-info">{statusMsg}</div>}
            {errorMsg && <div className="alert alert-error">{errorMsg}</div>}
          </div>
        )}

        {/* TABS */}
        <div className="tabs">
          <div
            className={`tab ${activeTab === "tenders" ? "active" : ""}`}
            onClick={() => setActiveTab("tenders")}
          >
            Licitaciones
          </div>
          <div
            className={`tab ${activeTab === "create" ? "active" : ""}`}
            onClick={() => setActiveTab("create")}
          >
            Crear licitación
          </div>
          <div
            className={`tab ${activeTab === "submit" ? "active" : ""}`}
            onClick={() => setActiveTab("submit")}
          >
            Enviar oferta (IPFS)
          </div>
          <div
            className={`tab ${activeTab === "evaluate" ? "active" : ""}`}
            onClick={() => setActiveTab("evaluate")}
          >
            Evaluar ofertas
          </div>
          <div
            className={`tab ${activeTab === "manage" ? "active" : ""}`}
            onClick={() => setActiveTab("manage")}
          >
            Gestionar evaluadores
          </div>
        </div>

        {/* SECCIÓN: LICITACIONES */}
        <div
          className={`content-section ${
            activeTab === "tenders" ? "active" : ""
          }`}
        >
          <h2>Listado de licitaciones</h2>
          {tenders.length === 0 ? (
            <div className="empty-state">
              <h3>No hay licitaciones aún</h3>
              <p>Crea una nueva licitación desde la pestaña "Crear licitación".</p>
            </div>
          ) : (
            <div id="tendersContainer">
              {tenders.map((t) => (
                <div key={t.id} className="tender-card">
                  <div className="tender-header">
                    <h3>{t.description}</h3>
                    <span className="chip status-chip">
                      {statusToLabel(t.status)}
                    </span>
                  </div>
                  <div className="tender-meta">
                    <span className="chip">
                      <strong>ID:</strong> {t.id}
                    </span>
                    <span className="chip">
                      <strong>Max. precio:</strong>{" "}
                      {t.maxPrice.toString()}
                    </span>
                    <span className="chip">
                      <strong>Participantes:</strong>{" "}
                      {t.participantCount.toString()}
                    </span>
                    <span className="chip">
                      <strong>Deadline:</strong>{" "}
                      {new Date(
                        Number(t.deadline) * 1000
                      ).toLocaleString()}
                    </span>
                    <span className="chip">
                      <strong>Ganador:</strong>{" "}
                      {t.winner === ZERO_ADDRESS
                        ? "—"
                        : `${t.winner.slice(0, 6)}...${t.winner.slice(-4)}`}
                    </span>
                  </div>
                  {role === "owner" || role === "evaluator" ? (
                    <button
                      className="btn btn-secondary small-btn"
                      onClick={() => handleCalculateWinner(t.id)}
                      disabled={loading}
                    >
                      Calcular ganador
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* SECCIÓN: CREAR LICITACIÓN */}
        <div
          className={`content-section ${
            activeTab === "create" ? "active" : ""
          }`}
        >
          <div className="card" style={{ marginBottom: "12px" }}>
            <h2>Crear nueva licitación</h2>
            <p>
              Solo el propietario del contrato puede crear nuevas licitaciones.
            </p>
          </div>

          <form onSubmit={handleCreateTender}>
            <div className="form-group">
              <label>Descripción</label>
              <textarea
                value={newTender.description}
                onChange={(e) =>
                  setNewTender({ ...newTender, description: e.target.value })
                }
              />
            </div>

            <div className="form-row">
              <div className="form-group">
                <label>Precio máximo (unidades)</label>
                <input
                  type="number"
                  value={newTender.maxPrice}
                  onChange={(e) =>
                    setNewTender({ ...newTender, maxPrice: e.target.value })
                  }
                />
              </div>
              <div className="form-group">
                <label>Plazo (días)</label>
                <input
                  type="number"
                  value={newTender.deadlineDays}
                  onChange={(e) =>
                    setNewTender({
                      ...newTender,
                      deadlineDays: e.target.value,
                    })
                  }
                />
              </div>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label>Peso precio (%)</label>
                <input
                  type="number"
                  value={newTender.weightPrice}
                  onChange={(e) =>
                    setNewTender({
                      ...newTender,
                      weightPrice: e.target.value,
                    })
                  }
                />
              </div>
              <div className="form-group">
                <label>Peso calidad (%)</label>
                <input
                  type="number"
                  value={newTender.weightQuality}
                  onChange={(e) =>
                    setNewTender({
                      ...newTender,
                      weightQuality: e.target.value,
                    })
                  }
                />
              </div>
            </div>

            <button
              type="submit"
              className="btn btn-primary"
              disabled={loading || role !== "owner"}
            >
              {loading ? "Enviando..." : "Crear licitación"}
            </button>
          </form>
        </div>

        {/* SECCIÓN: ENVIAR OFERTA */}
        <div
          className={`content-section ${
            activeTab === "submit" ? "active" : ""
          }`}
        >
          <div className="card" style={{ marginBottom: "12px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <img src={logo} className="App-logo" alt="ethereum logo" />
              <div>
                <h2>Enviar oferta con documentación en IPFS</h2>
                <p>
                  El archivo se sube a tu nodo IPFS local y su CID se guarda en
                  el contrato <code>IpfsStorage</code> y en{" "}
                  <code>PublicTender.submitOffer</code>.
                </p>
              </div>
            </div>
          </div>

          <form onSubmit={handleOfferSubmit}>
            <div className="form-row">
              <div className="form-group">
                <label>ID de la licitación</label>
                <input
                  type="number"
                  value={offerForm.tenderId}
                  onChange={(e) =>
                    setOfferForm({ ...offerForm, tenderId: e.target.value })
                  }
                />
              </div>
              <div className="form-group">
                <label>Precio ofertado (unidades)</label>
                <input
                  type="number"
                  value={offerForm.price}
                  onChange={(e) =>
                    setOfferForm({ ...offerForm, price: e.target.value })
                  }
                />
              </div>
            </div>

            <div className="form-group">
              <label>Fichero de documentación</label>
              <input type="file" name="data" onChange={retrieveFile} />
            </div>

            <button
              type="submit"
              className="btn btn-primary"
              disabled={loading || !account}
            >
              {loading ? "Subiendo..." : "Subir y enviar oferta"}
            </button>
          </form>

          {ipfsHash && (
            <div className="console" style={{ marginTop: 16 }}>
              <div>
                <strong>Último CID:</strong> {ipfsHash}
              </div>
              <br />
              <div>
                URL local (gateway):
                <br />
                <a
                  href={`http://127.0.0.1:8080/ipfs/${ipfsHash}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  http://127.0.0.1:8080/ipfs/{ipfsHash}
                </a>
              </div>
            </div>
          )}
        </div>

        {/* SECCIÓN: EVALUAR OFERTAS */}
        <div
          className={`content-section ${
            activeTab === "evaluate" ? "active" : ""
          }`}
        >
          <h2>Evaluar oferta</h2>
          <p style={{ marginBottom: 12 }}>
            Solo los evaluadores pueden evaluar ofertas de proveedores.
          </p>
          <form onSubmit={handleEvaluate}>
            <div className="form-row">
              <div className="form-group">
                <label>ID de la licitación</label>
                <input
                  type="number"
                  value={evaluationForm.tenderId}
                  onChange={(e) =>
                    setEvaluationForm({
                      ...evaluationForm,
                      tenderId: e.target.value,
                    })
                  }
                />
              </div>
              <div className="form-group">
                <label>Dirección del proveedor</label>
                <input
                  type="text"
                  value={evaluationForm.provider}
                  onChange={(e) =>
                    setEvaluationForm({
                      ...evaluationForm,
                      provider: e.target.value,
                    })
                  }
                />
              </div>
            </div>

            <div className="form-group">
              <label>Puntuación de calidad (0–100)</label>
              <input
                type="number"
                value={evaluationForm.qualityScore}
                onChange={(e) =>
                  setEvaluationForm({
                    ...evaluationForm,
                    qualityScore: e.target.value,
                  })
                }
              />
            </div>

            <button
              type="submit"
              className="btn btn-success"
              disabled={loading || role !== "evaluator"}
            >
              {loading ? "Enviando..." : "Evaluar oferta"}
            </button>
          </form>
        </div>

        {/* SECCIÓN: GESTIONAR EVALUADORES */}
        <div
          className={`content-section ${
            activeTab === "manage" ? "active" : ""
          }`}
        >
          <h2>Gestionar evaluadores</h2>
          <p style={{ marginBottom: 12 }}>
            Solo el propietario puede añadir o eliminar evaluadores.
          </p>
          <form style={{ marginBottom: 12 }}>
            <div className="form-group">
              <label>Dirección del evaluador</label>
              <input
                type="text"
                value={evaluatorAddr}
                onChange={(e) => setEvaluatorAddr(e.target.value)}
              />
            </div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button
                className="btn btn-primary"
                disabled={loading || role !== "owner"}
                onClick={handleAddEvaluator}
              >
                Añadir evaluador
              </button>
              <button
                className="btn btn-secondary"
                disabled={loading || role !== "owner"}
                onClick={handleRemoveEvaluator}
              >
                Eliminar evaluador
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

export default App;


//http://0.0.0.0:5001/ipfs/bafybeibozpulxtpv5nhfa2ue3dcjx23ndh3gwr5vwllk7ptoyfwnfjjr4q/#/files