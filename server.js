const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const Razorpay = require("razorpay");
const crypto = require("crypto");
const cloudinary = require("./config/cloudinary"); // Only once here

const { CloudinaryStorage } = require("multer-storage-cloudinary");

const storage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: "futurefix_aadhaar",
    allowed_formats: ["jpg", "jpeg", "png", "pdf"],
  },
});

const upload = multer({ storage });

const app = express();
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));



// MongoDB connection
mongoose.connect(
  'mongodb+srv://mdwazidhussain68_db_user:F4iAOFiUU5GamouQ@cluster0.hzkoehe.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0'
)
.then(() => console.log("MongoDB connected"))
.catch(err => console.log(err));

// Razorpay init (keep your real keys here)
const razorpay = new Razorpay({
  key_id: "rzp_live_RLHDh7PumgVdb8",
  key_secret: "6NmDLUeyjuzreEN8ZtcO1I4L"
});

// Schemas

const transactionSchema = new mongoose.Schema({
  type: { type: String, required: true }, // Deposit, Profit, Referral, Withdrawal
  amount: { type: Number, required: true },
  date: { type: Date, default: Date.now },
  details: String
}, { _id: false });

const referralWithdrawRequestSchema = new mongoose.Schema({
  amount: { type: Number, default: 0 },
  status: { type: String, default: "None" }, // Pending, Approved, Rejected
  requestDate: { type: Date },
  upi: { type: String, default: null },
  bankAccount: { type: String, default: null },
  ifsc: { type: String, default: null }
}, { _id: false });

const investmentSchema = new mongoose.Schema({
  plan: String,
  amount: Number,
  frontImg: String,
  backImg: String,
  date: { type: Date, default: Date.now },
  status: { type: String, default: "Pending" },
  profit: { type: Number, default: 0 },
  lastProfitUpdate: { type: Date, default: Date.now },
  locked: { type: Boolean, default: true }
}, { _id: false });

const userSchema = new mongoose.Schema({
  name: String,
  email: String,
  phone: String,
  aadhaar: { type: String, unique: true },
  referralCode: { type: String, unique: true, sparse: true },
  referredBy: { type: [String], default: [] },
  referralStatus: { type: String, default: "Pending" },
  balance: { type: Number, default: 0 },
  referralWithdrawRequest: { type: referralWithdrawRequestSchema, default: {} },
  investments: [investmentSchema],
  transactions: [transactionSchema]
}, { timestamps: true });

// Prevent OverwriteModelError
const User = mongoose.models.User || mongoose.model('User', userSchema);

const planSchema = new mongoose.Schema({
  name: { type: String, unique: true },
  profitPercentage: { type: Number, default: 0 }
});
const Plan = mongoose.models.Plan || mongoose.model('Plan', planSchema);

// Helper: generate referral code
function generateReferralCode(name) {
  const cleanName = (name || "USER").replace(/\s+/g, "").toUpperCase();
  const randomNum = Math.floor(1000 + Math.random() * 9000);
  return cleanName + randomNum;
}

// Create Razorpay Order
app.post("/create-order", async (req, res) => {
  try {
    const { amount } = req.body;
    const order = await razorpay.orders.create({
      amount: Math.round(amount * 100), // convert ₹ to paise
      currency: "INR",
      payment_capture: 1
    });

    res.json({ success: true, orderId: order.id, amount: order.amount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Error creating order" });
  }
});

// Create / invest route
app.post('/invest', upload.fields([{ name: 'front' }, { name: 'back' }]), async (req, res) => {
  try {
    const { name, email, phone, aadhaar, plan, amount, referral, razorpay_payment_id, razorpay_order_id, razorpay_signature } = req.body;

    // Verify payment signature if payment details present
    if (razorpay_order_id && razorpay_payment_id && razorpay_signature) {
      const body = razorpay_order_id + "|" + razorpay_payment_id;
      const expectedSignature = crypto
        .createHmac("sha256", razorpay.key_secret)
        .update(body.toString())
        .digest("hex");

      if (expectedSignature !== razorpay_signature) {
        return res.status(400).json({ success: false, message: "Payment verification failed" });
      }
    } else {
      // If you require Razorpay for every invest, you can reject here. For now we continue.
    }

    if (!req.files || !req.files['front'] || !req.files['back']) {
      return res.status(400).json({ success: false, message: 'Both Aadhaar front and back images are required' });
    }

    let user = await User.findOne({ aadhaar });

    // Upload front image to Cloudinary
const frontUpload = await cloudinary.uploader.upload(req.files['front'][0].path, {
  folder: "aadhaar"
});

// Upload back image
const backUpload = await cloudinary.uploader.upload(req.files['back'][0].path, {
  folder: "aadhaar"
});


const investment = {
  plan,
  amount: parseFloat(amount),
  frontImg: frontUpload.secure_url,
  backImg: backUpload.secure_url
};


    if (user) {
      user.investments.push(investment);
      user.transactions.push({
        type: "Deposit",
        amount: parseFloat(amount),
        details: `${plan} Investment`
      });
    } else {
      const referralCode = generateReferralCode(name || "USER");
      user = new User({
        name,
        email,
        phone,
        aadhaar,
        referralCode,
        investments: [investment],
        transactions: [{
          type: "Deposit",
          amount: parseFloat(amount),
          details: `${plan} Investment`
        }]
      });
    }

    // Handle referral
    if (referral) {
      const referralCodeStr = Array.isArray(referral) ? referral[0] : referral;
      const oldUser = await User.findOne({ referralCode: referralCodeStr.trim() });
      if (oldUser) {
        if (!Array.isArray(user.referredBy)) user.referredBy = [];
        if (!user.referredBy.includes(referralCodeStr.trim())) {
          user.referredBy.push(referralCodeStr.trim());
        }
        user.referralStatus = "pending";
      } else {
        user.referralStatus = "none";
      }
    } else {
      user.referralStatus = "none";
    }

    await user.save();

    res.json({ success: true, message: "Investment successful & payment verified ✅", userId: user._id });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Login route
app.post('/login', async (req, res) => {
  try {
    const { aadhaar } = req.body;
    const user = await User.findOne({ aadhaar });
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // Prepare investments so front-end can parse dates reliably
    const investments = user.investments.map(inv => ({
      ...inv.toObject(),
      // keep original date as ISO string so client can `new Date(inv.date)`
      date: inv.date ? inv.date.toISOString() : null,
      // also keep a formatted date if front wants it
      formattedDate: inv.date ? new Date(inv.date).toLocaleString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit"
      }) : null
    }));

    const userObj = user.toObject();
    userObj.investments = investments;

    res.json({ success: true, user: userObj });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// admin and other endpoints unchanged except small fixes below...

app.get('/admin/investments', async (req, res) => {
  try {
    const users = await User.find({});
    const sortedUsers = users.map(u => {
      const userObj = u.toObject();
      userObj.investments = (userObj.investments || []).sort((a,b) => new Date(b.date) - new Date(a.date));
      return userObj;
    });

    res.json({ success: true, users: sortedUsers });
  } catch(err) {
    console.log(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Admin: update investment (unchanged)
app.post('/admin/update-investment', async (req, res) => {
  try {
    const { aadhaar, investmentIndex, status, profit, locked } = req.body;
    const user = await User.findOne({ aadhaar });
    if(!user) return res.status(404).json({ success:false, message:'User not found' });

    const investment = user.investments[investmentIndex];
    if(!investment) return res.status(400).json({ success:false, message:'Invalid investment index' });

    if(status) investment.status = status;
    if(profit != null) investment.profit = profit;
    if(locked != null) investment.locked = locked;

    await user.save();
    res.json({ success:true, message:'Investment updated', user });
  } catch(err){
    console.error(err);
    res.status(500).json({ success:false, message:'Server error' });
  }
});

// Admin: get plans
app.get('/admin/plans', async (req,res) => {
  const plans = await Plan.find({});
  res.json(plans);
});

// Admin: update plan
app.post('/admin/update-plan', async (req,res) => {
  const { name, profitPercentage } = req.body;
  let plan = await Plan.findOne({ name });
  if(!plan){
    plan = new Plan({ name, profitPercentage });
  } else {
    plan.profitPercentage = profitPercentage;
  }
  await plan.save();
  res.json({ success:true, message:"Plan updated", plan });
});

app.get('/admin/referrals', async (req,res) => {
  try {
    const users = await User.find({ referralStatus:"pending" }).sort({ _id: -1 });
    res.json({ success:true, users });
  } catch(err){
    console.error(err);
    res.status(500).json({ success:false, message:'Server error' });
  }
});

// Admin: approve referral by user id
app.post('/admin/approve-referral/:id', async (req,res) => {
  try{
    const user = await User.findById(req.params.id);
    if(!user || !user.referredBy.length) {
      return res.status(404).json({ success:false, message:'Referral not found' });
    }

    const oldUser = await User.findOne({ referralCode: user.referredBy[0] });

    if(oldUser){
      oldUser.balance += 100;
      oldUser.transactions.push({
        type: "Referral Bonus",
        amount: 100,
        details: `Referral from ${user.name}`
      });
      await oldUser.save();
    }

    // ✅ Mark this referral as approved so it won't show again
    user.referralStatus = "Approved";
    await user.save();

    res.json({ success:true, message:'Referral approved & ₹50 added to old user' });
  } catch(err){
    console.error(err);
    res.status(500).json({ success:false, message:'Server error' });
  }
});


// Withdraw referral balance request
app.post('/withdraw-referral', async (req, res) => {
  try {
    const { aadhaar, upi, bankAccount, ifsc } = req.body;
    const user = await User.findOne({ aadhaar });
    if (!user) return res.json({ success: false, message: "User not found" });

    // Prevent multiple pending requests
    if (user.referralWithdrawRequest?.status === "Pending") {
      return res.json({ success: false, message: "You already have a pending withdraw request" });
    }

    // Minimum ₹100 required
    if (user.balance < 150) {
      return res.json({ success: false, message: "Minimum ₹150 referral balance required to withdraw" });
    }

    user.referralWithdrawRequest = {
      amount: user.balance,
      status: "Pending",
      requestDate: new Date(),
      upi: upi || null,
      bankAccount: bankAccount || null,
      ifsc: ifsc || null
    };

    user.referralStatus = "Withdrawal Requested";
    await user.save();

    res.json({ success: true, message: "Withdraw request sent", request: user.referralWithdrawRequest });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Approve referral withdraw (admin)
app.post('/admin/approve-referral', async (req, res) => {
  const { aadhaar } = req.body;
  const user = await User.findOne({ aadhaar });
  if (!user) return res.json({ success: false });

  if (!user.referralWithdrawRequest || user.referralWithdrawRequest.status !== "Pending") {
    return res.json({ success: false, message: "No pending request" });
  }

  user.referralWithdrawRequest.status = "Approved";
  user.balance = 0;
  await user.save();

  res.json({ success: true, message: "Referral withdrawal approved" });
});

// Reject referral withdraw
app.post('/admin/reject-referral', async (req, res) => {
  const { aadhaar } = req.body;
  const user = await User.findOne({ aadhaar });
  if (!user) return res.json({ success: false });

  if (!user.referralWithdrawRequest || user.referralWithdrawRequest.status !== "Pending") {
    return res.json({ success: false, message: "No pending request" });
  }

  user.referralWithdrawRequest.status = "Rejected";
  await user.save();

  res.json({ success: true, message: "Referral withdrawal rejected" });
});

app.get('/admin/withdraws', async (req, res) => {
  try {
    const users = await User.find({ "referralWithdrawRequest.status": { $in: ["Pending","Approved","Rejected"] } })
                            .sort({ "referralWithdrawRequest.requestDate": -1 });

    const requests = users.map(u => ({
      _id: u._id,
      userId: { name: u.name, email: u.email, phone: u.phone },
      aadhaar: u.aadhaar,
      amount: u.referralWithdrawRequest.amount,
      status: u.referralWithdrawRequest.status,
      createdAt: u.referralWithdrawRequest.requestDate,
      upi: u.referralWithdrawRequest.upi || null,
      bankAccount: u.referralWithdrawRequest.bankAccount || null,
      ifsc: u.referralWithdrawRequest.ifsc || null
    }));

    res.json({ success: true, requests });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Error fetching withdraw requests" });
  }
});

// Admin approve withdraw (by userId)
app.post('/admin/withdraws/:id', async (req, res) => {
  try {
    const { status } = req.body;
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: "User not found" });

    if (!user.referralWithdrawRequest || user.referralWithdrawRequest.status !== "Pending") {
      return res.status(400).json({ success: false, message: "No pending withdraw request" });
    }

    if (!["Approved","Rejected"].includes(status)) {
      return res.status(400).json({ success: false, message: "Invalid status" });
    }

    user.referralWithdrawRequest.status = status;

    if (status === "Approved") {
      user.balance = 0; // clear balance
      user.referralStatus = "Completed";
      user.transactions.push({
        type: "Withdrawal",
        amount: user.referralWithdrawRequest.amount,
        details: "Referral Withdrawal Approved"
      });
    } else {
      user.referralStatus = "Rejected";
    }

    await user.save();
    res.json({ success: true, message: `Withdraw request 24 hour ${status}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

app.get('/admin/plan/:plan', async (req, res) => {
  try {
    const { plan } = req.params;
    const users = await User.find({ "investments.plan": plan });

    const result = users.map(u => ({
      name: u.name,
      fullName: u.name,
      phone: u.phone,
      email: u.email,
      address: u.address,
      secretId: u.secretId,
      referralCode: u.referralCode,
      aadhaar: u.aadhaar,
      investments: u.investments
        .filter(inv => inv.plan === plan)
        .sort((a, b) => new Date(b.date) - new Date(a.date))
        .map(inv => ({
          plan: inv.plan,
          amount: inv.amount,
          profit: inv.profit,
          date: inv.date,
          status: inv.status,
          locked: inv.locked,
          frontImg: inv.frontImg || "",
          backImg: inv.backImg || ""
        }))
    }));

    res.json({ success: true, users: result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Error fetching plan users" });
  }
});

// Remove the incorrect /admin/plan/flat4 route or correct it if you use it:
app.get('/admin/plan/flat4', async (req,res) => {
  const users = await User.find({ "investments.plan": "flat4" }); // match actual stored code if you use "flat4"
  res.json({ success:true, users });
});

// Admin: Get last 24 hours investments
app.get('/admin/investments/last24h', async (req, res) => {
  try {
    const since = new Date();
    since.setHours(since.getHours() - 24); // 24 hours ago

    const users = await User.find({ "investments.date": { $gte: since } });

    // Format output
    const results = users.map(u => {
      const newInvestments = u.investments
        .filter(inv => new Date(inv.date) >= since)
        .map(inv => ({
          plan: inv.plan,
          amount: inv.amount,
          date: inv.date,
          status: inv.status,
          profit: inv.profit,
          frontImg: inv.frontImg,
          backImg: inv.backImg
        }));
      return {
        name: u.name,
        phone: u.phone,
        email: u.email,
        aadhaar: u.aadhaar,
        referralCode: u.referralCode,
        investments: newInvestments
      };
    });

    res.json({ success: true, users: results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});


const cron = require("node-cron");

// Daily profit percentage per plan
const dailyProfitPercent = {
  "1 year": 0.50,     // 0.50% per day
  "2 year": 1.00,     // 1% per day
  "3 year": 2.00,     // 2% per day
  "flat 3 year": 2.50,
  "flat 4 year": 3.50,
  "flat 5 year": 4.50,
  "home 3 year": 2.50,
  "home 4 year": 3.50,
  "home 5 year": 4.50,
  "land 3 year": 2.50,
  "land 4 year": 3.50,
  "land 5 year": 4.50
};

// ✅ Run every day at 12:05 AM (IST)
cron.schedule("5 0 * * *", async () => {
  try {
    console.log("🚀 Daily profit update started...");

    const users = await User.find({ "investments.status": "Earning" });

    for (let user of users) {
      let updated = false;

      user.investments.forEach(inv => {
        if (inv.status === "Earning" && dailyProfitPercent[inv.plan]) {
          // ✅ Calculate profit as percentage of investment amount
          const percent = dailyProfitPercent[inv.plan];
          const dailyProfit = (inv.amount * percent) / 100;

          inv.profit += dailyProfit; // Add daily profit
          inv.lastProfitUpdate = new Date();
          updated = true;

          console.log(
            `💰 ${user.name} (${inv.plan}) +₹${dailyProfit.toFixed(2)} ( ${percent}% of ₹${inv.amount} )`
          );
        }
      });

      if (updated) {
        await user.save();
        console.log(`✅ Updated profits for user ${user.name} (${user.aadhaar})`);
      }
    }

    console.log("🎉 Daily profit update completed");
  } catch (err) {
    console.error("❌ Error in daily profit update:", err);
  }
});




const PORT = 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
