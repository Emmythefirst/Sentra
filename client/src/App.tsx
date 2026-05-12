import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Landing from './pages/Landing/Landing';
import SetupFlow from './pages/SetupFlow/SetupFlow';
import Dashboard from './pages/Dashboard/Dashboard';
import AgentList from './pages/Agents/AgentList';
import './index.css';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/setup" element={<SetupFlow />} />
        <Route path="/agents" element={<AgentList />} />
        <Route path="/dashboard/:agentId" element={<Dashboard />} />
        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
    </BrowserRouter>
  );
}