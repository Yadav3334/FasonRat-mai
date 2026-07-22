import { useEffect, useState } from 'react';
import { usersApi } from '@/services/api';
import { useAuthStore } from '@/store/auth';
import type { UserItem, UserRole, Permission } from '@/types';
import { PERMISSION_GROUPS, ALL_PERMISSIONS, DEFAULT_USER_PERMISSIONS } from '@/types';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import {
  Users as UsersIcon, Plus, Trash2, X, Check,
  AlertCircle, ShieldCheck, Shield, RefreshCw, Lock, Search, Mail, Clock
} from 'lucide-react';
import { formatDate } from '@/lib/utils';

interface UserDialog {
  mode: 'create' | 'edit' | 'resetPassword' | 'permissions';
  userId?: number;
  initialData?: Partial<UserItem>;
}

export default function UsersPage() {
  const { user: currentUser } = useAuthStore();
  const [users, setUsers] = useState<UserItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<UserDialog | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [dialogLoading, setDialogLoading] = useState(false);
  const [search, setSearch] = useState('');

  const [formUsername, setFormUsername] = useState('');
  const [formEmail, setFormEmail] = useState('');
  const [formPassword, setFormPassword] = useState('');
  const [formRole, setFormRole] = useState<UserRole>('user');
  const [formPermissions, setFormPermissions] = useState<Permission[]>([]);

  useEffect(() => { fetchUsers(); }, []);

  const fetchUsers = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await usersApi.getAll();
      if (res.data.success) {
        setUsers(res.data.data);
      }
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Failed to load users');
    }
    setLoading(false);
  };

  const openCreateDialog = () => {
    setFormUsername('');
    setFormEmail('');
    setFormPassword('');
    setFormRole('user');
    setFormPermissions([...DEFAULT_USER_PERMISSIONS]);
    setDialogError(null);
    setDialog({ mode: 'create' });
  };

  const openEditDialog = (user: UserItem) => {
    setFormUsername(user.username);
    setFormEmail(user.email);
    setFormRole(user.role as UserRole);
    setFormPassword('');
    setFormPermissions(user.permissions || []);
    setDialogError(null);
    setDialog({ mode: 'edit', userId: user.id, initialData: user });
  };

  const openResetPasswordDialog = (user: UserItem) => {
    setFormPassword('');
    setDialogError(null);
    setDialog({ mode: 'resetPassword', userId: user.id, initialData: user });
  };

  const openPermissionsDialog = (user: UserItem) => {
    setFormPermissions(user.permissions || []);
    setDialogError(null);
    setDialog({ mode: 'permissions', userId: user.id, initialData: user });
  };

  const closeDialog = () => {
    setDialog(null);
    setDialogError(null);
    setDialogLoading(false);
  };

  const togglePermission = (perm: Permission) => {
    setFormPermissions(prev =>
      prev.includes(perm) ? prev.filter(p => p !== perm) : [...prev, perm]
    );
  };

  const handleCreate = async () => {
    setDialogLoading(true);
    setDialogError(null);
    try {
      const res = await usersApi.create({ username: formUsername, email: formEmail, password: formPassword, role: formRole, permissions: formRole === 'user' ? formPermissions : undefined });
      if (res.data.success) {
        await fetchUsers();
        closeDialog();
        return;
      }
      setDialogError(res.data.error || 'Failed to create user');
    } catch (err: any) {
      setDialogError(err?.response?.data?.error || 'Failed to create user');
    }
    setDialogLoading(false);
  };

  const handleEdit = async () => {
    if (!dialog?.userId) return;
    setDialogLoading(true);
    setDialogError(null);
    try {
      const res = await usersApi.update(dialog.userId, { username: formUsername, email: formEmail, role: formRole, permissions: formRole === 'user' ? formPermissions : undefined });
      if (res.data.success) {
        await fetchUsers();
        closeDialog();
        return;
      }
      setDialogError(res.data.error || 'Failed to update user');
    } catch (err: any) {
      setDialogError(err?.response?.data?.error || 'Failed to update user');
    }
    setDialogLoading(false);
  };

  const handleResetPassword = async () => {
    if (!dialog?.userId) return;
    setDialogLoading(true);
    setDialogError(null);
    try {
      const res = await usersApi.resetPassword(dialog.userId, formPassword);
      if (res.data.success) {
        closeDialog();
        return;
      }
      setDialogError(res.data.error || 'Failed to reset password');
    } catch (err: any) {
      setDialogError(err?.response?.data?.error || 'Failed to reset password');
    }
    setDialogLoading(false);
  };

  const handleSavePermissions = async () => {
    if (!dialog?.userId) return;
    setDialogLoading(true);
    setDialogError(null);
    try {
      const res = await usersApi.updatePermissions(dialog.userId, formPermissions);
      if (res.data.success) {
        await fetchUsers();
        closeDialog();
        return;
      }
      setDialogError(res.data.error || 'Failed to update permissions');
    } catch (err: any) {
      setDialogError(err?.response?.data?.error || 'Failed to update permissions');
    }
    setDialogLoading(false);
  };

  const handleDelete = async (userId: number) => {
    if (!confirm('Are you sure you want to delete this user?')) return;
    try {
      const res = await usersApi.delete(userId);
      if (res.data.success) {
        await fetchUsers();
      } else {
        setError(res.data.error || 'Failed to delete user');
      }
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Failed to delete user');
    }
  };

  const filteredUsers = users.filter((u) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      u.username.toLowerCase().includes(q) ||
      u.email.toLowerCase().includes(q) ||
      u.role.toLowerCase().includes(q)
    );
  });

  if (loading && users.length === 0) {
    return (
      <div className="flex items-center justify-center py-20">
        <RefreshCw className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Users</h1>
          <p className="text-muted-foreground mt-1 text-sm">Manage accounts, roles, and permissions</p>
        </div>
        <Button onClick={openCreateDialog} size="sm" className="gap-2 self-start">
          <Plus className="h-4 w-4" /> Add User
        </Button>
      </div>

      {error && (
        <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-sm flex items-center gap-2">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search users..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {filteredUsers.length === 0 ? (
          <div className="col-span-full flex flex-col items-center justify-center py-16 text-muted-foreground">
            <UsersIcon className="h-10 w-10 mb-3 opacity-40" />
            <p className="text-sm font-medium">No users found</p>
            <p className="text-xs mt-1">
              {search ? 'Try a different search' : 'Create your first user to get started'}
            </p>
          </div>
        ) : (
          filteredUsers.map((user) => {
            const isYou = currentUser?.id === user.id;
            return (
            <Card key={user.id} className={`shadow-sm hover:shadow-md transition-shadow ${isYou ? 'ring-1 ring-primary/50' : ''}`}>
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className={`h-10 w-10 rounded-full flex items-center justify-center text-sm font-bold shrink-0 ${isYou ? 'bg-primary text-primary-foreground' : 'bg-primary/10 text-primary'}`}>
                      {user.username[0]?.toUpperCase() || 'U'}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="font-medium text-sm truncate">{user.username}</p>
                        {isYou && (
                          <Badge className="text-[10px] px-1.5 py-0 shrink-0">You</Badge>
                        )}
                        {user.isDefault === 1 && (
                          <Badge variant="outline" className="text-[10px] px-1.5 py-0 shrink-0">Primary</Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        {user.role === 'admin' ? (
                          <Badge variant="default" className="gap-1 text-[10px] px-1.5 py-0">
                            <ShieldCheck className="h-2.5 w-2.5" /> Admin
                          </Badge>
                        ) : (
                          <Badge variant="secondary" className="gap-1 text-[10px] px-1.5 py-0">
                            <Shield className="h-2.5 w-2.5" /> User
                          </Badge>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    {user.isDefault !== 1 && (
                      <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => openEditDialog(user)}>
                        Edit
                      </Button>
                    )}
                    {user.role !== 'admin' && user.isDefault !== 1 && (
                      <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => openPermissionsDialog(user)}>
                        Perms
                      </Button>
                    )}
                    {user.isDefault !== 1 && (
                      <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => openResetPasswordDialog(user)}>
                        Reset
                      </Button>
                    )}
                    {user.isDefault !== 1 && (
                      <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive" onClick={() => handleDelete(user.id)} title="Delete">
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <Mail className="h-3 w-3" /> {user.email || 'No email'}
                  </span>
                  <span className="flex items-center gap-1">
                    <Clock className="h-3 w-3" /> {user.lastLogin ? formatDate(user.lastLogin) : 'Never logged in'}
                  </span>
                </div>

                <div className="mt-3">
                  <div className="flex items-center justify-between text-[10px] text-muted-foreground mb-1">
                    <span>Permissions</span>
                    <span>
                      {user.role === 'admin'
                        ? `All (${ALL_PERMISSIONS.length})`
                        : `${user.permissions?.length || 0}/${ALL_PERMISSIONS.length}`}
                    </span>
                  </div>
                  <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${user.role === 'admin' ? 'bg-orange-500' : 'bg-primary'}`}
                      style={{ width: user.role === 'admin' ? '100%' : `${((user.permissions?.length || 0) / ALL_PERMISSIONS.length) * 100}%` }}
                    />
                  </div>
                </div>
              </CardContent>
            </Card>
            );
          })
        )}
      </div>

      <Dialog open={dialog !== null} onOpenChange={(open) => { if (!open) closeDialog(); }}>
        <DialogContent className={dialog?.mode === 'permissions' ? 'max-w-lg' : 'max-w-md'}>
          <DialogHeader>
            <DialogTitle>
              {dialog?.mode === 'create' && 'Create New User'}
              {dialog?.mode === 'edit' && 'Edit User'}
              {dialog?.mode === 'resetPassword' && 'Reset Password'}
              {dialog?.mode === 'permissions' && (
                <span className="flex items-center gap-2">
                  <Lock className="h-5 w-5 text-primary" />
                  Permissions — {dialog?.initialData?.username}
                </span>
              )}
            </DialogTitle>
            <DialogDescription>
              {dialog?.mode === 'create' && 'Add a new user account to the system'}
              {dialog?.mode === 'edit' && 'Update user account details'}
              {dialog?.mode === 'resetPassword' && `Set a new password for ${dialog?.initialData?.username}`}
              {dialog?.mode === 'permissions' && `Toggle permissions for ${dialog?.initialData?.username}. Changes take effect after saving.`}
            </DialogDescription>
          </DialogHeader>

          <div className={`${dialog?.mode === 'permissions' ? 'max-h-[60vh] overflow-y-auto' : ''} space-y-4 py-2`}>
            {dialogError && (
              <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-sm flex items-center gap-2">
                <AlertCircle className="h-4 w-4 shrink-0" />
                {dialogError}
              </div>
            )}

            {dialog?.mode === 'resetPassword' ? (
              <div className="space-y-2">
                <Label htmlFor="reset-password">New Password</Label>
                <Input
                  id="reset-password"
                  type="password"
                  placeholder="Enter new password"
                  value={formPassword}
                  onChange={(e) => setFormPassword(e.target.value)}
                />
              </div>
            ) : dialog?.mode === 'permissions' ? (
              <div className="space-y-4">
                {PERMISSION_GROUPS.map((group) => (
                  <div key={group.label}>
                    <h4 className="text-sm font-semibold mb-2">{group.label}</h4>
                    <div className="rounded-lg border border-border divide-y divide-border">
                      {group.permissions.map((perm) => {
                        const isEnabled = formPermissions.includes(perm.key);
                        return (
                          <div key={perm.key} className="flex items-center justify-between py-2.5 px-3">
                            <div className="min-w-0 mr-3">
                              <p className="text-sm font-medium">{perm.label}</p>
                              <p className="text-xs text-muted-foreground">{perm.description}</p>
                            </div>
                            <button
                              type="button"
                              role="switch"
                              aria-checked={isEnabled}
                              aria-label={`Toggle ${perm.label} permission`}
                              onClick={() => togglePermission(perm.key)}
                              className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 ${
                                isEnabled ? 'bg-primary' : 'bg-muted'
                              }`}
                            >
                              <span
                                className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow transition duration-200 ${
                                  isEnabled ? 'translate-x-4' : 'translate-x-0'
                                }`}
                              />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="form-username">Username</Label>
                  <Input
                    id="form-username"
                    type="text"
                    placeholder="Enter username"
                    value={formUsername}
                    onChange={(e) => setFormUsername(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="form-email">Email</Label>
                  <Input
                    id="form-email"
                    type="email"
                    placeholder="Enter email"
                    value={formEmail}
                    onChange={(e) => setFormEmail(e.target.value)}
                  />
                </div>
                {dialog?.mode === 'create' && (
                  <div className="space-y-2">
                    <Label htmlFor="form-password">Password</Label>
                    <Input
                      id="form-password"
                      type="password"
                      placeholder="Enter password"
                      value={formPassword}
                      onChange={(e) => setFormPassword(e.target.value)}
                    />
                  </div>
                )}
                <div className="space-y-2">
                  <Label>Role</Label>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant={formRole === 'admin' ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => { setFormRole('admin'); setFormPermissions([...ALL_PERMISSIONS]); }}
                      className="gap-1"
                    >
                      <ShieldCheck className="h-3 w-3" /> Admin
                    </Button>
                    <Button
                      type="button"
                      variant={formRole === 'user' ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => { setFormRole('user'); setFormPermissions([...DEFAULT_USER_PERMISSIONS]); }}
                      className="gap-1"
                    >
                      <Shield className="h-3 w-3" /> User
                    </Button>
                  </div>
                  {formRole === 'admin' && (
                    <p className="text-xs text-muted-foreground">Admin users have all permissions automatically.</p>
                  )}
                  {formRole === 'user' && (
                    <p className="text-xs text-muted-foreground">User permissions can be customized after creation.</p>
                  )}
                </div>
              </div>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 pt-4 border-t border-border">
            <Button variant="outline" size="sm" onClick={closeDialog}>Cancel</Button>
            <Button
              size="sm"
              onClick={
                dialog?.mode === 'create' ? handleCreate :
                dialog?.mode === 'edit' ? handleEdit :
                dialog?.mode === 'permissions' ? handleSavePermissions :
                handleResetPassword
              }
              disabled={dialogLoading}
              className="gap-1.5"
            >
              {dialogLoading ? (
                'Saving...'
              ) : (
                <>
                  <Check className="h-3.5 w-3.5" />
                  {dialog?.mode === 'create' ? 'Create' : dialog?.mode === 'edit' ? 'Save' : dialog?.mode === 'permissions' ? 'Save Permissions' : 'Reset'}
                </>
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
