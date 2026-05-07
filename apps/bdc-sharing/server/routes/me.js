import { Router } from 'express';
import { getRequestUser } from '../auth.js';

const router = Router();

router.get('/', (req, res) => {
  const u = getRequestUser(req);
  res.json({
    userName: u.userName,
    email: u.email,
    preferredUsername: u.preferredUsername,
    displayName: u.userName,
  });
});

export default router;
